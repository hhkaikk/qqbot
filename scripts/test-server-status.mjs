// 固定状态指令的权限、真实指标口径与 PNG 输出；不连接生产 QQ。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isServerStatusCommand, memoryFromMeminfo, cpuUsagePercent, diskFromStatfs,
  collectServerStatus, renderServerStatusSvg, renderServerStatusPng } from '../src/server-status.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const at = { type: 'at', data: { qq: '42' } };
const text = value => ({ type: 'text', data: { text: value } });
const event = (user = 123) => ({ user_id: user, self_id: 42, group_id: 456,
  message_id: 12345, message: [at, text(' 状态')] });
const snapshot = { sampledAt: new Date('2026-10-22T12:00:00Z'), cpu: { cores: 2, percent: 12.5 },
  memory: { total: 2048 * 1024 ** 2, used: 1024 * 1024 ** 2, available: 1024 * 1024 ** 2, percent: 50 },
  disk: { total: 30 * 1024 ** 3, used: 20 * 1024 ** 3, available: 10 * 1024 ** 3, percent: 200 / 3 },
  uptimeSeconds: 90061, load: [0.1, 0.2, 0.3],
  services: { qq: true, dsh: true, bridge: true } };

test('群指令需要真实 @ 自己，不能被昵称或普通聊天误触发', () => {
  assert.equal(isServerStatusCommand('group', [at, text(' 状态 ')], '42'), true);
  assert.equal(isServerStatusCommand('group', [at, text('服务器状态')], '42'), true);
  for (const message of [[text('@大肥鱼 状态')], [at, text('状态怎么样')],
    [{ type: 'at', data: { qq: '99' } }, text('状态')],
    [at, { type: 'at', data: { qq: 'all' } }, text('状态')],
    [at, text('状态'), { type: 'image', data: {} }]]) {
    assert.equal(isServerStatusCommand('group', message, '42'), false);
  }
  assert.equal(isServerStatusCommand('private', [text('状态')], '42'), true);
  assert.equal(isServerStatusCommand('private', [text('/status')], '42'), false);
});

test('CQ 字符串与数组事件兼容，引用内容不会变成命令正文', () => {
  assert.equal(isServerStatusCommand('group', '[CQ:reply,id=12][CQ:at,qq=42] 状态', '42'), true);
  assert.equal(isServerStatusCommand('group', '[CQ:at,qq=99] 状态', '42'), false);
  assert.equal(isServerStatusCommand('group', '[CQ:at,qq=42][CQ:image,file=x]状态', '42'), false);
  assert.equal(isServerStatusCommand('private', '服务器状态', '42'), true);
  assert.equal(isServerStatusCommand('group', [at, text('状态')], ''), false);
});

test('Linux 内存采用 MemAvailable；缺失或矛盾数据保持不可用', () => {
  const result = memoryFromMeminfo('MemTotal: 2000 kB\nMemFree: 100 kB\nMemAvailable: 800 kB\n');
  assert.equal(result.used, 1200 * 1024);
  assert.equal(result.percent, 60);
  assert.equal(memoryFromMeminfo('MemTotal: 2000 kB\nMemFree: 100 kB\n'), null);
  assert.equal(memoryFromMeminfo('MemTotal: 2000 kB\nMemAvailable: 3000 kB\n'), null);
});

test('CPU 采用采样差值，磁盘区分已用和普通用户可用空间', () => {
  const cpu = (idle, user) => [{ times: { idle, user, sys: 0, nice: 0, irq: 0 } }];
  assert.equal(cpuUsagePercent(cpu(100, 100), cpu(175, 125)), 25);
  assert.equal(cpuUsagePercent(cpu(100, 100), cpu(100, 100)), null);
  assert.equal(cpuUsagePercent(cpu(100, 100), cpu(10, 10)), null);
  const result = diskFromStatfs({ blocks: 100n, bfree: 30n, bavail: 25n, bsize: 1024n });
  assert.deepEqual(result, { total: 102400, used: 71680, available: 25600, percent: 70 });
  assert.equal(diskFromStatfs({ blocks: 0n, bfree: 0n, bavail: 0n, bsize: 1024n }), null);
});

test('缺失数据不会显示成零或声称服务在线，SVG 文本经过转义', () => {
  const svg = renderServerStatusSvg({ ...snapshot, cpu: null, memory: null, disk: null,
    services: { qq: null, dsh: false, bridge: true } });
  assert.ok(svg.includes('暂不可用'));
  assert.ok(svg.includes('未连接'));
  assert.ok(!svg.includes('NaN'));
  assert.ok(!svg.includes('undefined'));
});

test('采样并渲染出有效 PNG，不包含地址、凭据或进程列表', async () => {
  const sample = await collectServerStatus({ sampleMs: 100 });
  assert.ok(sample.sampledAt instanceof Date);
  assert.ok(sample.cpu.cores > 0);
  assert.ok(sample.cpu.percent === null || (sample.cpu.percent >= 0 && sample.cpu.percent <= 100));
  const png = await renderServerStatusPng(snapshot);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1000);
  assert.equal(png.readUInt32BE(20), 760);
  const svg = renderServerStatusSvg(snapshot);
  assert.ok(!/Bearer|127\.0\.0\.1|\/opt\/|command|hostname/i.test(svg));
});

async function fixture(run, overrides = {}) {
  let collections = 0;
  const h = await bridgeHarness({ config: { sendDelayMs: 0 }, globals: {
    collectServerStatus: async () => { collections++; return snapshot; },
    renderServerStatusPng: async () => Buffer.from('fixture-png'), ...overrides,
  } });
  h.setMode('reserved2');
  h.setSelfIdentity('大肥鱼', '42');
  try { await run(h, () => collections); } finally { await h.close(); }
}

test('管理员指令直接发图，不创建模型会话；连续查询限流', () => fixture(async (h, count) => {
  h.setReady(false); // 即使 DSH 不可用，管理指令仍然可用
  await h.handleIncoming('group', 456, event(), h.cfg);
  await h.handleIncoming('group', 456, event(), h.cfg);
  assert.equal(count(), 1);
  const sends = h.calls.http.filter(c => c.url.endsWith('/send_group_msg'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.group_id, 456);
  assert.equal(sends[0].body.message.at(-1).type, 'image');
  assert.ok(sends[0].body.message.at(-1).data.file.startsWith('base64://'));
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.getSocialV2State('group:456').unread.length, 0);
}));

test('非管理员与未启用群不能触发采样', () => fixture(async (h, count) => {
  await h.handleIncoming('group', 456, event(999), h.cfg);
  await h.handleIncoming('group', 789, { ...event(), group_id: 789 }, h.cfg);
  assert.equal(count(), 0);
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_group_msg')).length, 0);
  assert.equal(h.calls.created.length, 0);
}));

test('管理员私聊支持状态指令，发送回当前私聊', () => fixture(async h => {
  await h.handleIncoming('private', 123, { ...event(), message: '状态' }, h.cfg);
  const send = h.calls.http.find(c => c.url.endsWith('/send_private_msg'));
  assert.equal(send.body.user_id, 123);
  assert.equal(send.body.message[0].type, 'image');
}));

test('DSH 连通探针使用当前桥接已支持的 settings.describe 协议', async () => {
  let observed;
  await fixture(async h => {
    h.api.callUnary = async method => {
      if (method !== 'settings.describe') throw new Error('unknown endpoint');
      return { result: { ok: true, value: { namespaces: [] } } };
    };
    await h.handleIncoming('group', 456, event(), h.cfg);
    assert.equal(observed.services.dsh, true);
  }, { renderServerStatusPng: async value => { observed = value; return Buffer.from('fixture-png'); } });
});

test('生成期间撤销白名单或更换管理员会取消发送', async () => {
  for (const revoke of [h => { h.cfg.allow.groups = []; }, h => { h.cfg.ownerQQ = 999; }]) {
    let hRef;
    await fixture(async h => {
      hRef = h;
      await h.handleIncoming('group', 456, event(), h.cfg);
      assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_group_msg')).length, 0);
      assert.equal(h.calls.sent.length, 0);
    }, { renderServerStatusPng: async () => { revoke(hRef); return Buffer.from('fixture-png'); } });
  }
});

test('渲染失败只返回通用提示，不把异常路径传到 QQ', () => fixture(async h => {
  await h.handleIncoming('group', 456, event(), h.cfg);
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_group_msg')).length, 0);
  assert.equal(h.calls.sent.length, 1);
  assert.ok(!JSON.stringify(h.calls.sent).includes('/private/secret'));
}, { renderServerStatusPng: async () => { throw new Error('/private/secret: failed'); } }));
