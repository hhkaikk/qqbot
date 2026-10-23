import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage } from '../src/qq-model-view.js';

test('自己的发言有机器人 QQ 身份，不能标成管理员', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('大肥鱼', '42');
    h.recordSentMessagesV2('group:456', ['我在']);
    const own = h.getSocialV2State('group:456').recentMessages.at(-1);
    assert.equal(own.isSelf, true);
    assert.equal(own.isOwner, false);
    assert.equal(own.userId, '42');
    assert.equal(own.ownerLabel, '');
  } finally { await h.close(); }
});

test('旧记录矛盾的自身管理员标签只在模型视图纠正，原始记录不覆盖', () => {
  const legacy = { sender: '我', text: '自己说的话', isSelf: true, isOwner: true, ownerLabel: '我' };
  const viewed = compactModelMessage(legacy);
  assert.equal(viewed.isSelf, true);
  assert.notEqual(viewed.isOwner, true);
  assert.equal(viewed.ownerLabel, undefined);
  assert.equal(legacy.isOwner, true);
});

test('同名群友、同人改名和机器人在快照中保持逐条身份', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'group:456';
    h.setSelfIdentity('大肥鱼', '42');
    h.appendSocialV2Message(key, '小明', '活着不', '活着不', false, true, '11', [], '123');
    h.recordSentMessagesV2(key, ['活着']);
    h.appendSocialV2Message(key, '小明', '这哪个', '这哪个', true, false, '12', [], '789');
    h.appendSocialV2Message(key, '新名片', '刚才是我问的', '刚才是我问的', false, true, '13', [], '123');
    const packet = h.buildWakeSnapshotV2(key);
    assert.deepEqual(Array.from(packet.messages, m => m.userId), ['123', '789', '123']);
    assert.deepEqual(Array.from(packet.messages, m => m.sender), ['小明', '小明', '新名片']);
    assert.equal(packet.messages[1].quoteTargetIsSelf, true);
    assert.equal(packet.recent[0].isSelf, true);
    assert.notEqual(packet.recent[0].isOwner, true);
  } finally { await h.close(); }
});

test('每次唤醒与身份工具都提示按 QQ 号逐条归属，不把 A 的经历算给 B', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    h.setMode('reserved2');
    const prompt = h.buildWakePromptV2('group:456', 'atMention');
    assert.match(prompt, /【说话人归属】/);
    assert.match(prompt, /userId/);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(r => server.once('listening', r));
    const body = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/socialV2/prompt?key=group:456', headers: { 'x-console-token': 'fixture-console-token' } }, res => {
        let data = ''; res.on('data', x => data += x); res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    assert.match(body.speakerHint, /userId/);
    assert.match(body.speakerHint, /引用/);
  } finally {
    if (server) await new Promise(r => server.close(r));
    await h.close();
  }
});
