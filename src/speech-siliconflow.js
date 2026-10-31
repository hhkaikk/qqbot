import { open, mkdtemp, chmod, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const ORIGIN = 'https://api.siliconflow.cn';
const PRESETS = new Set(['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'].map(name => `${MODEL}:${name}`));
const STYLE_PREFIX = Object.freeze({default:'',chat:'请自然地说话。<|endofprompt|>'});
const OWN_ERROR = Symbol('speechError');
const fail = (code, message) => Object.assign(new Error(message), { code, [OWN_ERROR]: true });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const validPath = value => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0');
const timeoutError = () => fail('SPEECH_TIMEOUT', '语音服务请求超时');
const outputError = () => fail('SPEECH_INVALID_OUTPUT', '语音服务返回内容无效或超过大小限制');
const keyError = () => fail('SPEECH_KEY_UNAVAILABLE', '硅基流动 API 密钥文件缺失或内容无效');

export function validateSiliconFlowVoice(value) {
  if (typeof value !== 'string' || value.length > 256 ||
      (!PRESETS.has(value) && !/^speech:[A-Za-z0-9_.:-]+$/.test(value))) {
    throw fail('SPEECH_INVALID_VOICE', '硅基流动音色格式无效');
  }
  return value;
}
export function validateSiliconFlowSpeakingStyle(value) {
  if(typeof value!=='string'||!Object.hasOwn(STYLE_PREFIX,value))throw fail('SPEECH_INVALID_CONFIG','语音说话方式无效');
  return value;
}

function validateConfig({ apiKeyFile, timeoutMs, fetchImpl }) {
  if (!validPath(apiKeyFile) || !positiveInteger(timeoutMs) || timeoutMs > 2147483647 || typeof fetchImpl !== 'function') {
    throw fail('SPEECH_INVALID_CONFIG', '语音服务配置无效');
  }
}

// The deadline races every await, including injected fetch/readers that ignore abort.
// An abandoned filesystem operation has its own late cleanup and cannot resume a request.
async function withDeadline(timeoutMs, execute) {
  const controller = new AbortController();
  let expired = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const context = {
    signal: controller.signal,
    check() { if (expired) throw timeoutError(); },
    run(promise, onLate) {
      const tracked = Promise.resolve(promise).then(value => {
        if (expired && onLate) Promise.resolve().then(() => onLate(value)).catch(() => {});
        return value;
      });
      return Promise.race([tracked, timeout]);
    },
  };
  try { return await Promise.race([Promise.resolve().then(() => execute(context)), timeout]); }
  finally { clearTimeout(timer); }
}

// Never allow best-effort closing/cancellation/cleanup to hold the caller forever.
async function bounded(task, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail('SPEECH_CLEANUP_FAILED', '语音临时文件清理失败')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
const close = handle => bounded(() => handle.close()).catch(() => {});
const cancel = stream => { try { Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch { /* Best effort only. */ } };

async function readLocal(context, filename, limit, makeError) {
  let handle;
  try {
    context.check();
    handle = await context.run(open(filename, 'r'), close);
    const info = await context.run(handle.stat());
    if (!info.isFile() || info.size <= 0 || info.size > limit) throw makeError();
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      context.check();
      const { bytesRead } = await context.run(handle.read(buffer, offset, buffer.length - offset, null));
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (!offset || offset > limit) throw makeError();
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error[OWN_ERROR] && error.code === 'SPEECH_TIMEOUT') throw error;
    throw makeError();
  } finally { if (handle) await close(handle); }
}

async function readKey(context, filename) {
  const buffer = await readLocal(context, filename, 2048, keyError);
  let key;
  try { key = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw keyError(); }
  if (!key || key.length > 512 || /[\s\x00-\x20\x7f]/u.test(key)) throw keyError();
  return key;
}

async function request(context, fetchImpl, endpoint, key, body, json = false) {
  let response;
  try {
    context.check();
    response = await context.run(fetchImpl(`${ORIGIN}${endpoint}`, {
      method: 'POST', redirect: 'error', signal: context.signal,
      headers: { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(body) : body,
    }), late => cancel(late?.body));
  } catch (error) {
    if (error[OWN_ERROR]) throw error;
    throw fail('SPEECH_REQUEST_FAILED', '硅基流动语音请求失败');
  }
  if (!response?.ok) {
    cancel(response?.body);
    if (response?.status === 401 || response?.status === 403) throw fail('SPEECH_AUTH_FAILED', '硅基流动 API 密钥无效或权限不足');
    if (response?.status === 402) throw fail('SPEECH_PAYMENT_REQUIRED', '硅基流动账户余额不足');
    if (response?.status === 429) throw fail('SPEECH_RATE_LIMITED', '硅基流动请求过于频繁，请稍后再试');
    throw fail('SPEECH_REQUEST_FAILED', '硅基流动语音请求失败');
  }
  return response;
}

async function readResponse(context, response, limit, audio = false) {
  let reader;
  let complete = false;
  try {
    if (audio && !/^(?:audio\/[A-Za-z0-9!#$&^_.+-]+|application\/octet-stream)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw outputError();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) throw outputError();
    reader = response.body?.getReader();
    if (!reader) throw outputError();
    const chunks = [];
    let bytes = 0;
    while (true) {
      context.check();
      const { done, value } = await context.run(reader.read());
      if (done) break;
      // Empty chunks make no progress and an injected resolved reader could
      // otherwise starve timers forever through an endless microtask loop.
      if (!(value instanceof Uint8Array) || !value.byteLength) throw outputError();
      bytes += value.byteLength;
      if (bytes > limit) throw outputError();
      chunks.push(Buffer.from(value));
    }
    if (!bytes) throw outputError();
    complete = true;
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error[OWN_ERROR]) throw error;
    throw outputError();
  } finally {
    if (!complete) cancel(reader || response.body);
    try { reader?.releaseLock(); } catch { /* A timed-out reader may still have a pending read. */ }
  }
}

function makeCleanup(getDirectory) {
  let cleanupTask;
  return function cleanup() {
    if (!cleanupTask) cleanupTask = bounded(async () => {
      const directory = getDirectory();
      if (!directory) return;
      // Only unlink our exact file and remove an empty directory; never recurse.
      await unlink(path.join(directory, 'output.mp3')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }).catch(() => {
      cleanupTask = undefined;
      throw fail('SPEECH_CLEANUP_FAILED', '语音临时文件清理失败');
    });
    return cleanupTask;
  };
}

/** SiliconFlow speech boundary. Construction does not read files or contact the service. */
export function createSiliconFlowSpeechSynthesizer({
  apiKeyFile, voice, tempDir = tmpdir(), timeoutMs = 20000,
  maxChars = 300, maxBytes = 3145728, fetchImpl = fetch, speakingStyle = 'default',
} = {}) {
  validateConfig({ apiKeyFile, timeoutMs, fetchImpl });
  validateSiliconFlowVoice(voice);
  validateSiliconFlowSpeakingStyle(speakingStyle);
  if (!validPath(tempDir) || ![maxChars, maxBytes].every(positiveInteger)) throw fail('SPEECH_INVALID_CONFIG', '语音服务配置无效');
  let active = false;
  return { async synthesize(text) {
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw fail('SPEECH_INVALID_TEXT', '语音文本不能为空或包含空字符');
    if (Array.from(text).length > maxChars) throw fail('SPEECH_TEXT_TOO_LONG', '语音文本超过长度限制');
    if (active) throw fail('SPEECH_BUSY', '语音合成繁忙');
    active = true;
    let directory;
    const cleanup = makeCleanup(() => directory);
    try {
      return await withDeadline(timeoutMs, async context => {
        try {
          const key = await readKey(context, apiKeyFile);
          const response = await request(context, fetchImpl, '/v1/audio/speech', key, {
            model: MODEL, input: STYLE_PREFIX[speakingStyle]+text, voice, response_format: 'mp3',
            // Leave headroom for MP3 decoding and the gateway's PCM/SILK conversion.
            // The original preview decoded above 0 dBFS with gain=0.
            sample_rate: 32000, stream: false, speed: 1, gain: -3,
          }, true);
          const bytes = await readResponse(context, response, maxBytes, true);
          context.check();
          directory = await context.run(mkdtemp(path.join(tempDir, 'qqbot-speech-')), late => rmdir(late));
          await context.run(chmod(directory, 0o700), cleanup);
          const output = path.join(directory, 'output.mp3');
          await context.run(writeFile(output, bytes, { mode: 0o600, flag: 'wx' }), cleanup);
          context.check();
          return { path: output, cleanup };
        } catch (error) {
          await cleanup().catch(() => {});
          if (error[OWN_ERROR]) throw error;
          throw fail('SPEECH_FAILED', '语音合成失败');
        }
      });
    } finally { active = false; }
  } };
}

/** Uploads caller-validated MP3 bytes; this helper never downloads or probes media. */
export async function uploadSiliconFlowVoice({
  apiKeyFile, audioPath, text, customName = 'dafeiyu', fetchImpl = fetch, timeoutMs = 20000,
} = {}) {
  validateConfig({ apiKeyFile, timeoutMs, fetchImpl });
  if (!validPath(audioPath) || typeof text !== 'string' || !text.trim() || text.includes('\0') ||
      text.length > 10000 || typeof customName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(customName)) {
    throw fail('SPEECH_INVALID_INPUT', '自定义音色上传参数无效');
  }
  return withDeadline(timeoutMs, async context => {
    try {
      const key = await readKey(context, apiKeyFile);
      const bytes = await readLocal(context, audioPath, 512 * 1024, () => fail('SPEECH_INVALID_INPUT', '参考音频无效或超过 512 KiB'));
      const form = new FormData();
      form.set('model', MODEL);
      form.set('customName', customName);
      form.set('text', text);
      form.set('file', new Blob([bytes], { type: 'audio/mpeg' }), 'reference.mp3');
      const response = await request(context, fetchImpl, '/v1/uploads/audio/voice', key, form);
      const buffer = await readResponse(context, response, 32 * 1024);
      let uri;
      try { uri = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)).uri; } catch { throw outputError(); }
      try { validateSiliconFlowVoice(uri); } catch { throw outputError(); }
      if (!uri.startsWith('speech:')) throw outputError();
      return uri;
    } catch (error) {
      if (error[OWN_ERROR]) throw error;
      throw fail('SPEECH_REQUEST_FAILED', '自定义音色上传失败');
    }
  });
}
