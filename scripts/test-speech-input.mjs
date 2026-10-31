import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeechInput } from '../src/speech-input.js';

const voice = (id = 71, extra = {}) => ({
  user_id: 12, self_id: 99, message_id: id, sender: { nickname: '小明', role: 'member' },
  message: [{ type: 'text', data: { text: '请听' } }, { type: 'record', data: { file: 'ignored.amr', url: 'https://invalid.invalid/never-fetch' } }], ...extra,
});
const record = event => event.message.find(segment => segment.type === 'record').data;

test('成功转写仅调用当前消息，复制事件并保持发送者、ID和其他段', async () => {
  const calls = [];
  const service = createSpeechInput({ call: async (...args) => { calls.push(args); return { text: '  今天下午开会。  ' }; } });
  const original = voice();
  const result = await service.enrich(original, { key: 'group:1' });
  assert.notEqual(result, original);
  assert.equal(record(result).transcript, '今天下午开会。');
  assert.equal(record(original).transcript, undefined);
  assert.deepEqual(result.sender, original.sender);
  assert.equal(result.message_id, original.message_id);
  assert.deepEqual(result.message[0], original.message[0]);
  assert.deepEqual(result.voiceStatus, { present: true, transcribed: true });
  assert.deepEqual(calls, [['fetch_ptt_text', { message_id: '71' }, { timeoutMs: 10000 }]]);
});

test('自身消息和无语音事件原样跳过', async () => {
  const service = createSpeechInput({ call: () => { throw new Error('不能调用'); } });
  const self = voice(1, { user_id: '99' });
  const text = { user_id: 12, message: [{ type: 'text', data: { text: '你好' } }] };
  assert.equal(await service.enrich(self, { key: 'group:1' }), self);
  assert.equal(await service.enrich(text, { key: 'group:1' }), text);
});

test('失败不猜词、不透传异常，也不沿用输入已有转写', async () => {
  const service = createSpeechInput({ call: async () => { throw new Error('secret URL token'); } });
  const event = voice();
  event.message[1].data.transcript = '虚构原文';
  const result = await service.enrich(event, { key: 'group:1' });
  assert.equal(record(result).transcript, undefined);
  assert.equal(record(result).transcriptError, '语音转写失败');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(result.voiceStatus, { present: true, transcribed: false });
});

test('空白、非字符串和超长转写拒绝，不截断内容', async () => {
  for (const text of ['', '  ', null, 17, '字'.repeat(4001)]) {
    const service = createSpeechInput({ call: async () => ({ text }) });
    const result = await service.enrich(voice(), { key: 'group:1' });
    assert.equal(record(result).transcript, undefined);
    assert.equal(typeof record(result).transcriptError, 'string');
    assert.equal(result.voiceStatus.transcribed, false);
  }
});

test('永不返回的调用也限时退出且不重试', async () => {
  let calls = 0;
  const service = createSpeechInput({ timeoutMs: 20, call: () => { calls++; return new Promise(() => {}); } });
  const started = Date.now();
  const result = await service.enrich(voice(), { key: 'group:1' });
  assert.equal(record(result).transcriptError, '语音转写超时');
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1);
});

test('仅安全整数或等价数字串可用，支持负ID、msg_id并拒绝URL等输入', async () => {
  const ids = [];
  const service = createSpeechInput({ call: async (_action, params) => { ids.push(params.message_id); return { text: '原文' }; } });
  for (const id of [-17, '-18', '+00019', '9007199254740991']) {
    assert.equal((await service.enrich(voice(id), { key: 'g' })).voiceStatus.transcribed, true);
  }
  assert.equal((await service.enrich(voice(undefined, { message_id: undefined, msg_id: '-20' }), { key: 'g' })).voiceStatus.transcribed, true);
  for (const id of [undefined, null, '', 'https://invalid.invalid', '1e3', 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', {}, true]) {
    const result = await service.enrich(voice(id, { message_id: id }), { key: 'g' });
    assert.equal(record(result).transcriptError, '语音消息编号无效');
  }
  assert.deepEqual(ids, ['-17', '-18', '19', '9007199254740991', '-20']);
});

test('同会话、用户、消息并发合并，其他会话和用户缓存隔离', async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createSpeechInput({ call: async () => { calls++; await pending; return { text: '实际原文' }; } });
  const first = service.enrich(voice(), { key: 'group:1' });
  const second = service.enrich(voice('071'), { key: 'group:1' });
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(record(results[1]).transcript, '实际原文');
  await service.enrich(voice(), { key: 'group:1' });
  assert.equal(calls, 1);
  await service.enrich(voice(), { key: 'group:2' });
  await service.enrich(voice(71, { user_id: 13 }), { key: 'group:1' });
  assert.equal(calls, 3);
});

test('缓存数量有界，成功到期重新识别', async () => {
  let clock = 0, calls = 0;
  const service = createSpeechInput({ cacheMax: 2, now: () => clock, call: async () => { calls++; return { text: '原文' }; } });
  for (const id of [1, 2, 3, 1]) await service.enrich(voice(id), { key: 'g' });
  assert.equal(calls, 4);
  clock = 600001;
  await service.enrich(voice(1), { key: 'g' });
  assert.equal(calls, 5);
});

test('失败仅短缓存，30秒后允许重新识别', async () => {
  let clock = 0, calls = 0;
  const service = createSpeechInput({ now: () => clock, call: async () => { calls++; throw new Error('失败'); } });
  await service.enrich(voice(), { key: 'g' });
  await service.enrich(voice(), { key: 'g' });
  assert.equal(calls, 1);
  clock = 30001;
  await service.enrich(voice(), { key: 'g' });
  assert.equal(calls, 2);
});

test('并发缓存已满时有界拒绝新任务，原任务仍合并', async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createSpeechInput({ cacheMax: 1, call: async () => { calls++; await pending; return { text: '原文' }; } });
  const first = service.enrich(voice(1), { key: 'g' });
  const duplicate = service.enrich(voice(1), { key: 'g' });
  const overflow = await service.enrich(voice(2), { key: 'g' });
  assert.equal(record(overflow).transcriptError, '语音转写繁忙');
  assert.equal(calls, 1);
  release();
  await Promise.all([first, duplicate]);
});
