// 真实模型冒烟验证：仅创建受限 qq-chat 测试会话，调用一次模型并归档。
// 会产生少量 API 用量；不会发送 QQ 消息，不读取或输出模型密钥。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const api = new NodeApiClient(cfg.dsh.baseUrl, 15000, {});
const checkPersona = process.argv.includes('--persona');
const visionArg = process.argv.indexOf('--vision-image');
const visionFile = visionArg >= 0 ? process.argv[visionArg + 1] : null;
// 与桥接的归一化和默认值一致，避免遗漏字段时验证了不同档位。
const configuredEffort = String(cfg.dsh.reasoningEffort ?? 'max').trim().toLowerCase();
const reasoningEffort = ['low', 'high', 'max'].includes(configuredEffort) ? configuredEffort : 'max';
let sessionId;
let turnTimer;
let openTimer;

async function main() {
  const cwd = path.join(os.tmpdir(), 'qqbot-model-smoke');
  fs.mkdirSync(cwd, { recursive: true });
  sessionId = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat' }), 'session.create').sessionId;
  const selection = unwrap(await api.sessions.selectModel({
    sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model, reasoningEffort,
  }), 'session.selectModel');
  if (selection.selected?.reasoningEffort !== reasoningEffort) throw new Error('实际模型推理档位与配置不一致');
  let onOpen;
  const opened = new Promise((resolve, reject) => {
    onOpen = resolve;
    openTimer = setTimeout(() => reject(new Error('事件连接 10 秒内未就绪')), 10000);
  });
  const stream = api.events.mux({}, undefined, () => { clearTimeout(openTimer); onOpen(); });
  const collector = createTurnCollector();
  const result = new Promise((resolve, reject) => {
    turnTimer = setTimeout(() => reject(new Error('真实模型 45 秒内没有完成回合')), 45000);
    (async () => {
      for await (const { payload } of stream) {
        if (payload.type !== 'session/event' || payload.sessionId !== sessionId) continue;
        const ended = collector.push(payload.event);
        if (ended) { clearTimeout(turnTimer); resolve(ended); return; }
      }
      reject(new Error('事件流提前结束'));
    })().catch(reject);
  });
  // 等待阶段发生异常时也不留下未处理的 rejection。
  result.catch(() => {});
  await opened;
  stream.follow(sessionId);
  let prompt = '这是连接测试，不要调用工具，只回复两个字：收到';
  if (checkPersona) {
    const response = await fetch(`http://127.0.0.1:${cfg.consolePort}/api/socialV2/prompt?key=group:${encodeURIComponent(String(process.env.QQ_TEST_GROUP_ID || cfg.allow?.groups?.[0] || ""))}`, {
      headers: { 'x-console-token': cfg.consoleToken }, signal: AbortSignal.timeout(15000),
    });
    const context = await response.json();
    if (!response.ok || context.role?.name !== '大肥鱼' || !context.role?.hint?.includes('大肥鱼')) {
      throw new Error('实际桥接提示词尚未启用大肥鱼人设');
    }
    prompt = `${context.role.hint}\n${context.self?.line || ''}\n这是离线身份检查，不向 QQ 发送消息。不要调用工具，只回答：你平时自称什么？只写名字。`;
  }
  if (visionFile) prompt = '这是图片识别测试，不调用工具，不发 QQ 消息。用一句话描述图片背景的颜色和中间的主要形状。';
  const content = [{ type: 'text', text: prompt }];
  if (visionFile) content.push({ type: 'image', mediaType: 'image/png', data: fs.readFileSync(visionFile).toString('base64'), name: 'vision-test.png' });
  unwrap(await api.sessions.prompt({
    sessionId, mode: 'queue', content,
  }), 'session.prompt');
  const ended = await result;
  const expected = checkPersona ? '大肥鱼' : '收到';
  const answerOk = visionFile ? /蓝/.test(ended.text) && /黄/.test(ended.text) && /圆/.test(ended.text)
    : ended.text.includes(expected) && !(checkPersona && /sev|se\./i.test(ended.text));
  if (ended.reason.kind !== 'completed' || !answerOk) {
    throw new Error(`真实模型未通过：reason=${ended.reason.kind}，回复=${ended.text.slice(0, 300)}`);
  }
  console.log(`真实模型验证通过：${cfg.dsh.provider}/${cfg.dsh.model} (${reasoningEffort})，回复：${ended.text.trim()}`);
}

let code = 0;
try { await main(); }
catch (error) {
  console.error(String(error?.message ?? error).replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]'));
  code = 1;
} finally {
  clearTimeout(openTimer);
  clearTimeout(turnTimer);
  if (sessionId) {
    try { await api.stopSessionWork(sessionId); } catch {}
    try { unwrap(await api.workspace.archiveSession({ sessionId }), 'archive'); console.log('测试会话已归档'); }
    catch { console.error('测试会话归档失败，请在 DSH 中检查'); code = 1; }
  }
}
process.exit(code);
