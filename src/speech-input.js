// 仅以当前 QQ 消息编号请求 OneBot 原生转写；不解析 URL、文件或模型输出。
const MAX_TEXT_LENGTH = 4000;
const FAILURE_TTL_MS = 30000;
const bounded = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;

function messageId(value) {
  if (typeof value === 'string') {
    value = value.trim();
    if (!/^[+-]?\d+$/.test(value)) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
}

/**
 * call 与 createOneBotHttp 一致：成功直接返回 data。
 * 调用方须先完成白名单、静默及功能开关检查；key 是经过权限检查的会话标识。
 * enrich 不修改输入，只给当前消息的 record 段添加可信 transcript 或固定错误。
 */
export function createSpeechInput({ call, timeoutMs = 10000, cacheMax = 200,
  cacheTtlMs = 600000, now = Date.now } = {}) {
  if (typeof call !== 'function') throw new TypeError('语音转写调用器无效');
  const deadlineMs = bounded(timeoutMs, 10000, 1, 30000);
  const capacity = bounded(cacheMax, 200, 1, 10000);
  const successTtlMs = bounded(cacheTtlMs, 600000, 0, 600000);
  // 已完成结果和进行中请求共用同一个有界表，满载时不驱逐进行中的请求。
  const cache = new Map();

  async function transcribe(id) {
    let timer;
    try {
      const data = await Promise.race([
        Promise.resolve().then(() => call('fetch_ptt_text', { message_id: id }, { timeoutMs: deadlineMs })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'SPEECH_TIMEOUT' })), deadlineMs);
        }),
      ]);
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!text) return { error: '语音转写未返回文字' };
      if (text.length > MAX_TEXT_LENGTH) return { error: '语音转写内容过长' };
      return { text };
    } catch (error) {
      return { error: error?.code === 'SPEECH_TIMEOUT' || error?.code === 'ONEBOT_TIMEOUT'
        ? '语音转写超时' : '语音转写失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  function obtain(id, key, userId) {
    const time = now();
    for (const [entryKey, entry] of cache) {
      if (!entry.pending && entry.expiresAt <= time) cache.delete(entryKey);
    }
    const entryKey = JSON.stringify([String(key ?? ''), String(userId ?? ''), id]);
    const existing = cache.get(entryKey);
    if (existing) return existing.promise;
    while (cache.size >= capacity) {
      const disposable = [...cache].find(([, entry]) => !entry.pending);
      if (!disposable) return Promise.resolve({ error: '语音转写繁忙' });
      cache.delete(disposable[0]);
    }
    const entry = { pending: true, expiresAt: Infinity, promise: null };
    entry.promise = transcribe(id).then(result => {
      entry.pending = false;
      entry.expiresAt = now() + (result.text ? successTtlMs : Math.min(FAILURE_TTL_MS, successTtlMs));
      return result;
    });
    cache.set(entryKey, entry);
    return entry.promise;
  }

  return {
    async enrich(event, { key } = {}) {
      if (!Array.isArray(event?.message) || !event.message.some(segment => segment?.type === 'record')) return event;
      if (event.user_id != null && event.self_id != null && String(event.user_id) === String(event.self_id)) return event;
      const id = messageId(event.message_id ?? event.msg_id);
      const result = id === null ? { error: '语音消息编号无效' } : await obtain(id, key, event.user_id);
      return {
        ...event,
        message: event.message.map(segment => {
          if (segment?.type !== 'record') return segment;
          const data = { ...segment.data };
          delete data.transcript;
          delete data.transcriptError;
          if (result.text) data.transcript = result.text;
          else data.transcriptError = result.error;
          return { ...segment, data };
        }),
        voiceStatus: { present: true, transcribed: Boolean(result.text) },
      };
    },
  };
}
