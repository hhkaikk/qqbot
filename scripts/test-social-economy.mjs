import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { unreadPage, beginHostObservation, hostObservationActive } from '../src/social-economy.js';
import * as policy from '../src/social-economy.js';

async function fixture(run) {
  const h = await bridgeHarness({ config: { socialV2: { economy: { hostObservation: true, followupWindowMs: 30000 },
    proactive: { enabled: false }, sticker: { enabled: false } } } });
  h.setMode('reserved2');
  const key = 'group:456', st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/api/socialV2/' + route + (route.includes('?') ? '&' : '?') + 'key=' + key,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, ...headers },
    }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('fixture timeout')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = text => h.appendSocialV2Message(key, 'fixture', text, text, false, false, 'fixture-' + (st.lastUnreadSeq + 1), [], '789', []);
  try { await run({ h, key, st, request, append }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('精确展示收据不能越过未展示缺口，历史复查仍完整', () => {
  const st = { unread: [1, 2, 3].map(seq => ({ seq })), modelSeenSeqs: new Set([3]) };
  assert.deepEqual(unreadPage(st, { limit: 3, unseenOnly: true }).messages.map(m => m.seq), [1, 2]);
  assert.deepEqual(unreadPage(st, { limit: 3, afterSeq: 0 }).messages.map(m => m.seq), [1, 2, 3]);
});

test('宿主观察只有新消息到达时参与判断，过期与令牌轮换使其失效', () => {
  const cfg = { socialV2: { economy: { hostObservation: true } } }, st = { agentToken: 'one' };
  beginHostObservation(st, cfg, 1000);
  assert.equal(hostObservationActive(st, cfg, 2000), true);
  assert.equal(hostObservationActive(st, cfg, 31000), false);
  st.agentToken = 'two';
  assert.equal(hostObservationActive(st, cfg, 2000), false);
});

test('不参与的连续接话不滚动续窗，实际发言或新直接互动才续窗', () => {
  const cfg = { socialV2: { economy: { hostObservation: true, followupWindowMs: 60000 } } };
  const st = { agentToken: 'one', lastWakeReason: 'atMention', lastAiReplyAt: 900 };
  assert.equal(beginHostObservation(st, cfg, 1000), 61000);
  st.lastWakeReason = 'followup';
  assert.equal(beginHostObservation(st, cfg, 10000), 61000);
  assert.equal(beginHostObservation(st, cfg, 70000), 61000, '过期不能因为又看一眼就复活');
  st.lastAiReplyAt = 71000;
  assert.equal(beginHostObservation(st, cfg, 72000), 132000, '真正接话后继续保持活跃');
  assert.equal(beginHostObservation(st, cfg, 80000), 132000);
  st.lastWakeReason = 'atMention';
  assert.equal(beginHostObservation(st, cfg, 90000), 150000);
});

test('夜间主动概率按配置时区计算，不随服务器 UTC 偏移', () => {
  const date = Date.parse('2026-10-23T15:30:00Z');
  assert.equal(typeof policy.proactiveLocalHour, 'function');
  const cfg = timeZone => ({ socialV2: { proactive: { timeZone } } });
  assert.equal(policy.proactiveLocalHour(cfg('Asia/Shanghai'), date), 23);
  assert.equal(policy.proactiveLocalHour(cfg('UTC'), date), 15);
  assert.equal(policy.proactiveLocalHour(cfg('bad-zone'), date), null);
  assert.equal(policy.proactiveLocalHour(cfg('Asia/Shanghai'), NaN), null);
});

test('宿主接管开启时，各种唤醒和提醒不再要求旧式空等收尾', () => fixture(async ({ h, key }) => {
  for (const reason of ['bootstrap', 'replyCheck', 'proactiveCheck', 'poke', 'followup']) {
    const prompt = h.buildWakePromptV2(key, reason);
    assert.match(prompt, /qq_wait_for_messages\(purpose="messages"\)/, reason);
    assert.doesNotMatch(prompt, /先等够观察窗口|收尾（qq_mark_read 或 qq_set_wake_config）|设置你希望如何被唤醒|先调用 qq_wait_for_messages\(timeoutMs=/, reason);
  }
  const reminder = h.buildWakeReminderPromptV2(key);
  assert.match(reminder, /handedOff=true/);
  assert.doesNotMatch(reminder, /timeoutMs=/);
  h.cfg.socialV2.economy.hostObservation = false;
  assert.match(h.buildWakePromptV2(key, 'followup'), /先等够观察窗口/);
  assert.match(h.buildWakeReminderPromptV2(key), /timeoutMs=/);
}));

test('快照展示后增量读取为空，但未读保留；显式复查可以取回原文', () => fixture(async ({ h, key, st, request, append }) => {
  append('消息正文'); await h.sendWakePromptV2(key, 'question');
  const fresh = await request('unread?unseenOnly=1');
  assert.equal(fresh.body.messages.length, 0);
  assert.equal(fresh.body.unreadCount, 1);
  assert.equal(fresh.body.omittedSeenCount, 1);
  const history = await request('unread?afterSeq=0');
  assert.equal(history.body.messages.length, 1);
  assert.equal(st.unread.length, 1);
}));

test('无新增消息可立即移交宿主，不等待超时、不额外投递模型提示', () => fixture(async ({ h, key, st, request, append }) => {
  append('你好'); await h.sendWakePromptV2(key, 'question');
  const calls = h.calls.prompts.length, started = Date.now();
  const result = await request('wait', { purpose: 'messages', handoff: true, timeoutMs: 300000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.handedOff, true);
  assert.equal(result.body.shouldEndTurn, true);
  assert.ok(Date.now() - started < 500);
  assert.equal(st.unread.length, 0);
  assert.equal(h.calls.prompts.length, calls);
  assert.equal(st.preSleepWaitObservedAt, 0, '移交不是伪造已观察');
  assert.ok(st.lastActionAt >= started, '移交应计为有效收尾，避免误触无行动重置');
  assert.ok(st.hostObservation.until > Date.now());
  assert.equal(h.markReadCalledKeys.has(key), true, '结束回合不再补发模型提醒');
}));

test('移交后新消息保留未读，普通接话与真正 @ 仍能唤醒', () => fixture(async ({ h, key, st, request, append }) => {
  append('第一句'); await h.sendWakePromptV2(key, 'question');
  await request('wait', { handoff: true });
  st.wakeConfig.triggers = { atMention: true, probability: 0 };
  append('新接话');
  assert.equal(st.unread.length, 1);
  assert.equal(h.evaluateWakeTriggerV2(key, st, {}, 'group', '新接话', '新接话', false), 'followup');
  assert.equal(h.evaluateWakeTriggerV2(key, st, { self_id: 42, message: [{ type: 'at', data: { qq: 42 } }] }, 'group', '', '', false), 'atMention');
  st.hostObservation.until = Date.now() - 1;
  assert.equal(h.evaluateWakeTriggerV2(key, st, {}, 'group', '普通消息', '普通消息', false), null);
}));

test('移交清理已排队和限频延后的回复检查，保留真实消息唤醒', () => fixture(async ({ h, key, st, request, append }) => {
  append('已处理'); await h.sendWakePromptV2(key, 'question');
  st.pendingWakeReasons = [{ reason: 'replyCheck', seq: 1 }, { reason: 'atMention', seq: 2 }];
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 100);
  st.rateLimitRetryTimer = timer; st.rateLimitRetryReason = 'replyCheck';
  try {
    await request('wait', { handoff: true });
    assert.deepEqual(Array.from(st.pendingWakeReasons, x => x.reason), ['atMention']);
    assert.equal(st.rateLimitRetryTimer, null);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fired, false);
  } finally { clearTimeout(timer); }
}));

test('会话别名移交统一清理规范会话的检查与收尾标记', () => fixture(async ({ h, key, st, request, append }) => {
  append('已展示'); await h.sendWakePromptV2(key, 'question');
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 100);
  st.replyCheckTimer = timer;
  try {
    const result = await request('wait', { key: 'group:0456', handoff: true });
    assert.equal(result.body.handedOff, true);
    assert.equal(result.body.key, key);
    assert.equal(st.replyCheckTimer, null);
    assert.equal(h.markReadCalledKeys.has(key), true);
    assert.equal(h.markReadCalledKeys.has('group:0456'), false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fired, false);
  } finally { clearTimeout(timer); }
}));

test('关闭读取时交接不泄露正文；关闭确认工具时不能确认消息', () => fixture(async ({ h, key, st, request, append }) => {
  h.cfg.socialV2.tools = { ...h.cfg.socialV2.tools, getUnread: false, getRecent: false };
  append('不能展示');
  const hidden = await request('wait', { handoff: true });
  assert.equal(hidden.body.newMessages.length, 0);
  assert.equal(hidden.body.handedOff, false);
  assert.equal(st.unread.length, 1);
  assert.equal(hidden.body.readThroughSeq, 0);
  h.cfg.socialV2.tools.getUnread = true;
  await request('unread?unseenOnly=1');
  h.cfg.socialV2.tools.markRead = false;
  const blocked = await request('wait', { handoff: true });
  assert.equal(blocked.status, 403);
  assert.equal(st.unread.length, 1);
}));

test('只允许最近消息时，交接不能借未读缓冲泄露已淘汰的旧消息', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.context = { recentLimit: 1, unreadLimit: 30 };
  h.cfg.socialV2.tools = { ...h.cfg.socialV2.tools, getUnread: false, getRecent: true };
  append('旧消息一'); append('旧消息二'); append('最新消息');
  const result = await request('wait', { handoff: true });
  assert.equal(result.body.newMessages.length, 1);
  assert.equal(result.body.newMessages[0].seq, 3);
  assert.equal(result.body.readThroughSeq, 0);
  assert.equal(st.unread.length, 3);
}));

test('生成快照后才到达的消息先返回，不能被移交操作清除', () => fixture(async ({ h, key, st, request, append }) => {
  append('第一句'); await h.sendWakePromptV2(key, 'question'); append('新补充');
  const result = await request('wait', { purpose: 'messages', handoff: true });
  assert.equal(result.body.handedOff, false);
  assert.equal(result.body.newMessages.length, 1);
  assert.equal(st.unread.length, 2);
  const fresh = await request('unread?unseenOnly=1');
  assert.equal(fresh.body.messages.length, 0);
  assert.equal(st.unread.length, 2);
}));

test('权限撤销与工具关闭阻断交接，不确认消息', () => fixture(async ({ h, key, st, request, append }) => {
  append('保留'); await h.sendWakePromptV2(key, 'question');
  h.cfg.allow.groups = [];
  const denied = await request('wait', { handoff: true });
  assert.equal(denied.status, 403);
  assert.equal(st.unread.length, 1);
}));
