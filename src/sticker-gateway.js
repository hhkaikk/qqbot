// 收藏/备注扩展不是 OneBot 标准的一部分，按网关隔离差异。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { looksLikeImageBuffer } from './safe-fetch.js';

function checked(response, action) {
  if (response?.status !== 'ok' || response.retcode !== 0) {
    throw new Error(`${action} 失败: ${response?.wording || response?.retcode || 'unknown'}`);
  }
  // NapCat 的外层 ok 只说明动作被调用，原生接口还可能返回失败。
  if (response.data?.result !== undefined && Number(response.data.result) !== 0) {
    throw new Error(`${action} 失败: ${response.data.errMsg || response.data.result}`);
  }
  return response;
}

async function nativeFavorites(bot) {
  const response = checked(await bot.request('fetch_custom_face_detail', { count: 500 }), 'fetch_custom_face_detail');
  if (!Array.isArray(response.data)) throw new Error('收藏详情不是数组，已停止操作');
  return response.data;
}

export async function addStickerToGateway(bot, cfg, buffer, assertAllowed = () => {}) {
  if (!Buffer.isBuffer(buffer) || !looksLikeImageBuffer(buffer)) throw new Error('收藏内容不是有效图片');
  if (cfg.snowluma?.gateway !== 'napcat') {
    assertAllowed();
    return checked(await bot.request('add_custom_face', { file: 'base64://' + buffer.toString('base64') }), 'add_custom_face');
  }
  const { stickerTransferDir: hostDir, stickerGatewayDir: gatewayDir } = cfg.snowluma;
  if (!hostDir || !path.isAbsolute(hostDir) || !gatewayDir || !path.posix.isAbsolute(gatewayDir)) {
    throw new Error('NapCat 收藏需要配置共享图片目录及容器内路径');
  }
  await fs.mkdir(hostDir, { recursive: true, mode: 0o700 });
  const ext = buffer.subarray(0, 3).toString() === 'GIF' ? '.gif'
    : buffer[0] === 0x89 ? '.png' : buffer.subarray(0, 4).toString() === 'RIFF' ? '.webp' : '.jpg';
  const name = crypto.randomUUID() + ext;
  const localFile = path.join(hostDir, name);
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  let created = false;
  let added = false;
  try {
    const file = await fs.open(localFile, 'wx', 0o600);
    created = true;
    try { await file.writeFile(buffer); } finally { await file.close(); }
    assertAllowed();
    checked(await bot.request('add_custom_face', {
      file: path.posix.join(gatewayDir, name), md5, file_name: name, file_size: buffer.length,
    }), 'add_custom_face');
    added = true;
    // 原生添加只返回 result/errMsg，不能假定它会返回 emoji_id。
    // 只重查列表，绝不重复添加；缓存更新稍有延迟时最多等待一秒。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
      let entries;
      try { entries = await nativeFavorites(bot); }
      catch { break; }
      const match = entries.find((entry) => String(entry.md5).toLowerCase() === md5);
      if (match?.resId) return { status: 'ok', retcode: 0, data: { emoji_id: String(match.resId) } };
    }
    return { status: 'ok', retcode: 0, data: { pending_sync: true, md5 } };
  } finally {
    if (created) {
      try { await fs.rm(localFile, { force: true }); }
      catch (error) { error.stickerAdded = added; throw error; }
    }
  }
}

export async function modifyStickerOnGateway(bot, cfg, entry, desc, assertAllowed = () => {}) {
  if (cfg.snowluma?.gateway !== 'napcat') {
    assertAllowed();
    return checked(await bot.request('modify_custom_face', { emoji_id: entry.id, desc }), 'modify_custom_face');
  }
  const native = (await nativeFavorites(bot)).find((item) => String(item.resId) === String(entry.resId || entry.id));
  if (!native || !Number.isFinite(Number(native.emoId)) || !native.md5) {
    throw new Error('找不到表情的原生资源信息，未修改备注');
  }
  assertAllowed();
  return checked(await bot.request('set_custom_face_desc', {
    emoji_id: Number(native.emoId), res_id: native.resId, md5: native.md5, desc,
  }), 'set_custom_face_desc');
}
