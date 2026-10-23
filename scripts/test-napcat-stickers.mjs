// 按已部署 NapCat 的实际 OneBot 契约验证；不连接 QQ、不修改真实收藏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { addStickerToGateway, modifyStickerOnGateway } from '../src/sticker-gateway.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const image = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
const md5 = crypto.createHash('md5').update(image).digest('hex');
const favorite = { emoId: 7, resId: 'native-resource', url: 'https://example.invalid/a.gif', md5, desc: '' };

test('NapCat 收藏使用共享文件，按 MD5 找回原生返回中缺失的 emoji_id，随后清理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-napcat-sticker-'));
  const cfg = { snowluma: { gateway: 'napcat', stickerTransferDir: dir, stickerGatewayDir: '/qqbot-stickers' } };
  let guards = 0;
  const bot = { async request(action, payload) {
    if (action === 'add_custom_face') {
      assert.ok(payload.file.startsWith('/qqbot-stickers/'));
      assert.deepEqual(fs.readFileSync(path.join(dir, path.posix.basename(payload.file))), image);
      assert.equal(payload.md5, md5);
      return { status: 'ok', retcode: 0, data: { result: 0, errMsg: '' } };
    }
    assert.equal(action, 'fetch_custom_face_detail');
    return { status: 'ok', retcode: 0, data: [favorite] };
  } };
  try {
    const result = await addStickerToGateway(bot, cfg, image, () => { guards++; });
    assert.equal(result.data.emoji_id, favorite.resId);
    assert.equal(guards, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('NapCat 内层失败不能当作收藏成功，临时文件仍清理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-napcat-sticker-'));
  try {
    await assert.rejects(addStickerToGateway({ request: async () => ({ status: 'ok', retcode: 0, data: { result: 1, errMsg: '收藏已满' } }) },
      { snowluma: { gateway: 'napcat', stickerTransferDir: dir, stickerGatewayDir: '/qqbot-stickers' } }, image), /收藏已满/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('原生收藏已成功、详情回查失败时返回待同步，不误报添加失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-napcat-sticker-'));
  let additions = 0;
  try {
    const result = await addStickerToGateway({ async request(action) {
      if (action === 'add_custom_face') { additions++; return { status: 'ok', retcode: 0, data: { result: 0 } }; }
      throw new Error('详情暂不可用');
    } }, { snowluma: { gateway: 'napcat', stickerTransferDir: dir, stickerGatewayDir: '/qqbot-stickers' } }, image);
    assert.equal(result.retcode, 0);
    assert.equal(result.data.pending_sync, true);
    assert.equal(additions, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('NapCat 备注从原生详情解析数字 emoId，传齐 res_id 和 md5', async () => {
  const calls = [];
  const result = await modifyStickerOnGateway({ async request(action, payload) {
    calls.push({ action, payload });
    return { status: 'ok', retcode: 0, data: action === 'fetch_custom_face_detail' ? [favorite] : { result: 0 } };
  } }, { snowluma: { gateway: 'napcat' } }, { id: favorite.resId, resId: favorite.resId }, '开心');
  assert.equal(result.retcode, 0);
  assert.deepEqual(calls[1], { action: 'set_custom_face_desc', payload: { emoji_id: 7, res_id: favorite.resId, md5, desc: '开心' } });
});

test('SnowLuma 仍使用原有 base64 和备注动作', async () => {
  const calls = [];
  const bot = { async request(action, payload) { calls.push({ action, payload }); return { status: 'ok', retcode: 0, data: { emoji_id: 'legacy' } }; } };
  await addStickerToGateway(bot, {}, image);
  await modifyStickerOnGateway(bot, {}, { id: 'legacy' }, '开心');
  assert.equal(calls[0].payload.file, 'base64://' + image.toString('base64'));
  assert.deepEqual(calls[1], { action: 'modify_custom_face', payload: { emoji_id: 'legacy', desc: '开心' } });
});

test('真实桥接可收藏 mface 市场表情，且白名单变更后禁止在途收藏', async () => {
  const h = await bridgeHarness({ globals: { safeFetchBuffer: async () => ({ buffer: image }) } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', '群友', '[表情]', '[表情]', false, false, '1001', [
      { kind: 'sticker', url: 'https://example.invalid/sticker.gif', emojiId: 'abcdef0123456789abcdef0123456789', subType: '1' },
    ], '999');
    const calls = [];
    h.bot.request = async (action, payload) => {
      calls.push({ action, payload });
      return { status: 'ok', retcode: 0, data: action === 'add_custom_face' ? { emoji_id: 'collected' }
        : action === 'fetch_custom_face_detail' ? [{ emoji_id: 'collected', url: 'https://example.invalid/sticker.gif' }] : {} };
    };
    const result = await h.collectStickerV2('group:456', '1001', '开心');
    assert.equal(result.emojiId, 'collected');
    assert.equal(calls[0].payload.file, 'base64://' + image.toString('base64'));
    h.cfg.allow.groups = [];
    await assert.rejects(h.collectStickerV2('group:456', '1001', ''), /白名单|模式/);
    assert.equal(calls.filter((c) => c.action === 'add_custom_face').length, 1);
  } finally { await h.close(); }
});

test('收藏待同步通过真实控制台路由返回成功，仍占用次数且不重复添加', async () => {
  const h = await bridgeHarness({
    config: { socialV2: { sticker: { collect: { maxPerMinute: 1, maxPerHour: 1 } } } },
    globals: {
      safeFetchBuffer: async () => ({ buffer: image }),
      addStickerToGateway: async (_bot, _cfg, _image, guard) => { guard(); return { status: 'ok', retcode: 0, data: { pending_sync: true } }; },
    },
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', '群友', '[表情]', '[表情]', false, false, '1001', [
      { kind: 'image', url: 'https://example.invalid/a.gif' },
    ], '999');
    const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/collect-sticker`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      body: JSON.stringify({ key: 'group:456', messageId: '1001', remark: '开心' }), signal: AbortSignal.timeout(3000),
    });
    const first = await post();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).pendingSync, true);
    assert.equal(h.getSocialV2State('group:456').stickerCollectTimes.length, 1);
    const second = await post();
    assert.equal(second.status, 429);
    await second.arrayBuffer();
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});
