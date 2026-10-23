// 固定、只读的主机状态快照。没有命令执行、模型工具或用户提供的路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderAsync } from '@resvg/resvg-js';

export function isServerStatusCommand(kind, message, selfId) {
  let ownAt = false;
  let invalid = false;
  let body = '';
  const accept = (type, data = {}) => {
    if (type === 'text') body += String(data.text ?? '');
    else if (type === 'at' && selfId && String(data.qq) === String(selfId)) ownAt = true;
    else if (type !== 'reply') invalid = true;
  };
  if (Array.isArray(message)) {
    for (const segment of message) accept(segment?.type, segment?.data);
  } else if (typeof message === 'string') {
    body = message.replace(/\[CQ:([^,\]]+)(?:,([^\]]*))?\]/g, (_match, type, params = '') => {
      accept(type, Object.fromEntries(params.split(',').filter(Boolean).map(p => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)];
      })));
      return '';
    });
  } else return false;
  return !invalid && (kind === 'private' || (kind === 'group' && ownAt))
    && /^(?:服务器)?状态$/.test(body.trim());
}

const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function memoryFromMeminfo(text) {
  const field = name => {
    const match = String(text).match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = field('MemTotal');
  const available = field('MemAvailable');
  if (!valid(total) || total === 0 || !valid(available) || available > total) return null;
  const used = total - available;
  return { total, available, used, percent: used / total * 100 };
}

export function cpuUsagePercent(before, after) {
  if (!Array.isArray(before) || !before.length || before.length !== after?.length) return null;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < before.length; i++) {
    for (const name of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = after[i].times[name] - before[i].times[name];
      if (!valid(delta)) return null;
      total += delta;
      if (name === 'idle') idle += delta;
    }
  }
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}

export function diskFromStatfs(stats) {
  try {
    const { blocks, bfree, bavail, bsize } = Object.fromEntries(
      ['blocks', 'bfree', 'bavail', 'bsize'].map(key => [key, Number(stats[key])]));
    if (![blocks, bfree, bavail, bsize].every(valid) || blocks === 0 || bsize === 0
        || bfree > blocks || bavail > bfree) return null;
    return { total: blocks * bsize, used: (blocks - bfree) * bsize,
      available: bavail * bsize, percent: (blocks - bfree) / blocks * 100 };
  } catch { return null; }
}

const safely = fn => { try { return fn(); } catch { return null; } };

export async function collectServerStatus({ sampleMs = 600 } = {}) {
  const before = safely(() => os.cpus());
  const root = process.platform === 'win32' ? path.parse(process.cwd()).root : '/';
  const [memory, disk] = await Promise.all([
    process.platform === 'linux'
      ? fs.promises.readFile('/proc/meminfo', 'utf8').then(memoryFromMeminfo).catch(() => null)
      : Promise.resolve(safely(() => {
        const total = os.totalmem();
        const available = os.freemem();
        return { total, available, used: total - available, percent: (total - available) / total * 100 };
      })),
    fs.promises.statfs(root, { bigint: true }).then(diskFromStatfs).catch(() => null),
    delay(Math.max(100, Math.min(1000, Number(sampleMs) || 600))),
  ]);
  const after = safely(() => os.cpus());
  return { sampledAt: new Date(), cpu: { cores: after?.length || null, percent: cpuUsagePercent(before, after) },
    memory, disk, uptimeSeconds: safely(() => os.uptime()),
    load: process.platform === 'win32' ? null : safely(() => os.loadavg()) };
}

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;',
  '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const number = value => valid(value) ? value.toFixed(1) : '暂不可用';
const gib = value => valid(value) ? `${(value / 1024 ** 3).toFixed(1)} GiB` : '暂不可用';
const percent = value => valid(value) ? `${value.toFixed(1)}%` : '暂不可用';
function uptime(value) {
  if (!valid(value)) return '暂不可用';
  const minutes = Math.floor(value / 60);
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes / 60) % 24} 小时 ${minutes % 60} 分钟`;
}

export function renderServerStatusSvg(snapshot) {
  const { cpu, memory, disk, load, services = {} } = snapshot;
  const cyan = '#6bdfef';
  const muted = '#96a7c0';
  const tx = (x, y, value, size = 22, fill = '#ecf3ff', extra = '') =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(value)}</text>`;
  const rect = (x, y, w, h, fill, r = 20) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
  const card = (x, y, title, value, detail, usage) => {
    const color = valid(usage) && usage >= 85 ? '#ffbc7b' : cyan;
    const bar = valid(usage) ? rect(x + 24, y + 133, Math.max(0.1, 402 * Math.min(100, usage) / 100), 6, color, 3) : '';
    return rect(x, y, 450, 166, '#17253b') + tx(x + 24, y + 36, title, 23, muted)
      + tx(x + 24, y + 93, value, value === '暂不可用' ? 36 : 48, '#ecf3ff', 'font-weight="600"')
      + tx(x + 24, y + 120, detail, 18, muted)
      + rect(x + 24, y + 133, 402, 6, '#293c55', 3) + bar;
  };
  const service = (x, name, state) => {
    const label = state === true ? '已连接' : state === false ? '未连接' : '暂不可用';
    const color = state === true ? '#70e0ba' : state === false ? '#ffbc7b' : muted;
    return `<circle cx="${x}" cy="611" r="6" fill="${color}"/>`
      + tx(x + 18, 603, name, 22) + tx(x + 18, 633, label, 21, color);
  };
  const date = new Date(snapshot.sampledAt);
  const stamp = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date) : '采样时间暂不可用';
  const loadValue = Array.isArray(load) && load.length === 3 && load.every(valid) ? load.map(number).join(' / ') : '暂不可用';
  const cores = cpu?.cores ? `${cpu.cores} 核` : '核心数暂不可用';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760" viewBox="0 0 1000 760">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#101f36"/><stop offset="1" stop-color="#091322"/></linearGradient></defs>
    <rect width="1000" height="760" rx="28" fill="url(#bg)"/>
    <g font-family="WenQuanYi Zen Hei, Microsoft YaHei, sans-serif">
      ${tx(40, 67, '大肥鱼 · 服务器状态', 36, '#ecf3ff', 'font-weight="600"')}
      ${tx(960, 61, stamp, 20, muted, 'text-anchor="end"')}
      ${tx(40, 110, `开机 ${uptime(snapshot.uptimeSeconds)}  ·  ${cores}`, 21, muted)}
      ${tx(960, 99, '北京时间 · 即时快照', 18, muted, 'text-anchor="end"')}
      ${card(40, 150, 'CPU 使用率', percent(cpu?.percent), `${cores} · 约 0.6 秒采样`, cpu?.percent)}
      ${card(510, 150, '内存使用率', percent(memory?.percent), memory ? `已用 ${gib(memory.used)} / 总计 ${gib(memory.total)}` : '内存读数暂不可用', memory?.percent)}
      ${card(40, 336, '系统盘使用率', percent(disk?.percent), disk ? `已用 ${gib(disk.used)} · 可用 ${gib(disk.available)}` : '磁盘读数暂不可用', disk?.percent)}
      ${card(510, 336, '系统平均负载', loadValue, '依次为近 1 / 5 / 15 分钟平均负载', null)}
      ${rect(40, 522, 920, 156, '#17253b')}
      ${tx(64, 561, '机器人服务连接', 23, muted)}
      ${service(70, 'QQ 网关', services.qq)}
      ${service(370, 'DSH 接口', services.dsh)}
      ${service(670, '消息桥接', services.bridge)}
      ${tx(40, 719, '只读采样 · 内存已用值扣除可回收缓存 · 不调用聊天模型', 19, muted)}
    </g></svg>`;
}

export async function renderServerStatusPng(snapshot, { fontFile = process.env.QQBOT_STATUS_FONT } = {}) {
  const fonts = fontFile ? [fontFile] : [
    '/opt/qqbot/runtime/fonts/wqy-zenhei.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    'C:/Windows/Fonts/msyh.ttc',
  ].filter(file => fs.existsSync(file));
  if (fonts.length === 0) throw new Error('状态图缺少中文字体，请配置 QQBOT_STATUS_FONT');
  const image = await renderAsync(renderServerStatusSvg(snapshot), {
    font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'WenQuanYi Zen Hei' },
  });
  return image.asPng();
}
