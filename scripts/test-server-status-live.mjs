// 服务器只读采样与 PNG 冒烟；仅显式 --send-to-owner 时向已授权管理员私聊发一张图。
import fs from 'node:fs';
import { NodeApiClient } from '../src/dsh-client.js';
import { collectServerStatus, renderServerStatusPng } from '../src/server-status.js';
import { probeBotConnections } from '../src/service-health.js';
import { createOneBotHttp } from '../src/onebot-http.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const out = new URL('../state/status/', import.meta.url);
const call = createOneBotHttp(cfg.snowluma);
const started = Date.now();
try {
  const api = new NodeApiClient(cfg.dsh.baseUrl, 3000, {});
  const [sample, services] = await Promise.all([
    collectServerStatus(),
    probeBotConnections({ gateway: cfg.snowluma, dshApi: api,
      bridge: { baseUrl: `http://127.0.0.1:${cfg.consolePort}`, consoleToken: cfg.consoleToken } }, { timeoutMs: 3000 }),
  ]);
  const snapshot = { ...sample, services };
  const png = await renderServerStatusPng(snapshot);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  fs.writeFileSync(new URL('server-preview.png', out), png, { mode: 0o600 });
  const result = { ...snapshot, pngBytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    sentToOwner: false, readbackHasImage: null };
  if (process.argv.includes('--send-to-owner')) {
    if (!/^\d+$/.test(String(cfg.ownerQQ)) || !cfg.allow?.private?.map(String).includes(String(cfg.ownerQQ))) {
      throw new Error('管理员私聊未启用，取消测试发送');
    }
    const sent = await call('send_private_msg', { user_id: Number(cfg.ownerQQ),
      message: [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }] });
    if (!sent.message_id) throw new Error('发送未返回消息编号');
    const received = await call('get_msg', { message_id: sent.message_id });
    result.sentToOwner = true;
    result.messageId = sent.message_id;
    result.readbackHasImage = Array.isArray(received.message) && received.message.some(segment => segment.type === 'image');
    if (!result.readbackHasImage) throw new Error('发送后的消息回读缺少图片');
  }
  result.elapsedMs = Date.now() - started;
  fs.writeFileSync(new URL('live-result.json', out), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error('服务器状态图片实测失败；未输出内部异常或凭据。');
  process.exitCode = 1;
}
