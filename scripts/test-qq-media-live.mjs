// 真实测试，会向 config.ownerQQ 私聊发送三条消息；必须获得用户授权后显式加开关。
// 创建的唯一测试收藏在 finally 中清理；不删除或修改已有收藏，不向群聊发送。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addStickerToGateway, modifyStickerOnGateway } from '../src/sticker-gateway.js';

if (!process.argv.includes('--send-to-owner')) throw new Error('需要明确授权后使用 --send-to-owner');
const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const owner = String(cfg.ownerQQ);
if (!/^\d+$/.test(owner) || !cfg.allow?.private?.map(String).includes(owner)) throw new Error('管理员不在私聊白名单');
const key = `private:${owner}`;
const report = { checkedAt: new Date().toISOString(), destination: key, checks: [] };
const work = path.join(root, 'state', 'media-live');
fs.mkdirSync(work, { recursive: true, mode: 0o700 });
let testEntry;
let baselineIds;
function check(value, name) {
  if (!value) throw new Error(name);
  report.checks.push(name);
  console.log('PASS', name);
}
async function onebot(action, payload = {}) {
  const r = await fetch(`${cfg.snowluma.httpUrl.replace(/\/$/, '')}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.snowluma.accessToken}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
  });
  const b = await r.json();
  if (!r.ok || b.status !== 'ok' || b.retcode !== 0) throw new Error(`${action} 失败: ${b.wording || b.retcode || r.status}`);
  return b;
}
const bot = { request: onebot };
let agentToken;
async function bridge(endpoint, payload, agent = false) {
  const r = await fetch(`http://127.0.0.1:${cfg.consolePort}${endpoint}`, {
    method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': cfg.consoleToken,
      ...(agent ? { 'x-agent-token': agentToken } : {}) },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(25000),
  });
  const b = await r.json();
  if (!r.ok || !b.ok) throw new Error(`${endpoint}: ${b.error || r.status}`);
  return b;
}
function makePng() {
  const crc = (bytes) => {
    let n = 0xffffffff;
    for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); }
    const out = Buffer.alloc(4); out.writeUInt32BE((n ^ 0xffffffff) >>> 0); return out;
  };
  const chunk = (type, bytes) => {
    const t = Buffer.from(type), len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, t, bytes, crc(Buffer.concat([t, bytes]))]);
  };
  const width = 256, header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const p = y * (width * 3 + 1) + 1 + x * 3;
    const circle = (x - 128) ** 2 + (y - 128) ** 2 < 75 ** 2;
    pixels.set(circle ? [255, 220, 30] : [35, 100, 220], p);
  }
  // 唯一元数据避免与已有图片重复，图形本身仍是固定的蓝底黄圆测试图。
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('qqbot-test\0' + crypto.randomUUID())), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
let code = 0;
try {
  const login = (await onebot('get_login_info')).data;
  check(String(login.user_id) !== owner && (await onebot('get_status')).data.online === true, '机器人在线，目标为管理员私聊');
  const favorites = (await onebot('fetch_custom_face_detail', { count: 500 })).data;
  check(Array.isArray(favorites), '真实收藏列表可读取');
  baselineIds = new Set(favorites.map((e) => String(e.resId)));
  report.favoritesBefore = baselineIds.size;
  agentToken = JSON.parse(fs.readFileSync(path.join(root, 'state/social-v2.json'), 'utf8')).conversations[key]?.agentToken;
  check(!!agentToken, '管理员会话令牌已就绪');
  await bridge('/api/send/private', { userId: owner, token: agentToken, message: '我是大肥鱼，现在做一次功能自检：接下来会发蓝底黄圆测试图和表情，不用回复。' }, true);
  check(true, '桥接文字发送成功');
  const png = makePng();
  const image = (await onebot('send_private_msg', { user_id: Number(owner), message: [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }] })).data;
  const imageReadback = (await onebot('get_msg', { message_id: image.message_id })).data;
  check(imageReadback.message?.some((s) => s.type === 'image'), '普通图片发送后回读到 QQ 图片段');
  const added = await addStickerToGateway(bot, cfg, png);
  check(!added.data.pending_sync && !!added.data.emoji_id, '测试图片通过 NapCat 成功收藏并取得资源 ID');
  const list = (await onebot('fetch_custom_face_detail', { count: 500 })).data;
  testEntry = list.find((e) => String(e.resId) === added.data.emoji_id);
  check(!!testEntry && !baselineIds.has(String(testEntry.resId)), '新收藏与已有收藏严格区分');
  await modifyStickerOnGateway(bot, cfg, { id: testEntry.resId }, '功能自检蓝底黄圆');
  check(true, '原生收藏备注接口成功');
  await bridge('/api/stickers/sync', {});
  const fetched = await bridge(`/api/socialV2/sticker-image?key=${key}&stickerId=${encodeURIComponent(testEntry.resId)}`, undefined, true);
  check(!!fetched.image?.data && fetched.image.mimeType === 'image/png', '通过真实 QQ CDN 下载到收藏图片');
  const visionFile = path.join(work, 'vision-test.png');
  fs.writeFileSync(visionFile, Buffer.from(fetched.image.data, 'base64'), { mode: 0o600 });
  await bridge('/api/socialV2/send-sticker', { key, stickerId: testEntry.resId }, true);
  const recent = await bridge(`/api/socialV2/recent?key=${key}&limit=5`);
  const messageId = recent.messages.filter((m) => m.isSelf && m.sticker?.id === testEntry.resId).at(-1)?.messageId;
  const stickerReadback = messageId ? (await onebot('get_msg', { message_id: messageId })).data : null;
  check(stickerReadback?.message?.some((s) => s.type === 'image'), '桥接发送收藏表情后回读到 QQ 图片段');
  const vision = spawnSync(process.execPath, [path.join(root, 'scripts/test-dsh-chat-smoke.mjs'), '--vision-image', visionFile],
    { encoding: 'utf8', timeout: 60000, env: process.env });
  if (vision.stdout) process.stdout.write(vision.stdout);
  if (vision.stderr) process.stderr.write(vision.stderr);
  check(vision.status === 0, 'DSH 实际模型识别 QQ CDN 图片的颜色与形状');
  report.imageMessageId = image.message_id;
  report.stickerMessageId = messageId;
} catch (error) { console.error(String(error?.message || error).replace(/sk-[\w-]+/g, '[已隐藏]')); report.error = String(error?.message || error); code = 1; }
finally {
  if (testEntry && baselineIds && !baselineIds.has(String(testEntry.resId))) {
    try {
      const cleanup = await onebot('delete_custom_face', { res_id: String(testEntry.resId) });
      if (cleanup.data?.result !== undefined && Number(cleanup.data.result) !== 0) throw new Error('测试收藏清理失败');
      await bridge('/api/stickers/sync', {});
      const remaining = (await onebot('fetch_custom_face_detail', { count: 500 })).data;
      check(remaining.length === baselineIds.size && remaining.every((e) => baselineIds.has(String(e.resId))), '仅清理本次测试收藏，原有收藏完整保留');
      report.favoritesAfter = remaining.length;
    } catch (error) { console.error(error.message); report.cleanupError = error.message; code = 1; }
  }
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
process.exit(code);
