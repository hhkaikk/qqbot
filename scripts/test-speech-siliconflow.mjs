import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

let api;
try { api = await import('../src/speech-siliconflow.js'); } catch { /* The first red run verifies the missing provider. */ }
assert.ok(api, '硅基流动语音模块应存在');
const { createSiliconFlowSpeechSynthesizer: create, validateSiliconFlowVoice: validate, uploadSiliconFlowVoice: upload } = api;
const voice = 'FunAudioLLM/CosyVoice2-0.5B:anna';
const root = await mkdtemp(path.join(tmpdir(), 'qqbot-siliconflow-test-'));
const keyFile = path.join(root, 'key');
await writeFile(keyFile, 'private-test-key');
const audio = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
const options = extra => ({ apiKeyFile: keyFile, voice, tempDir: root, ...extra });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code && !/private-test-key|secret-body/.test(error.message));
const never = () => new Promise(() => {});

try {
  await test('语音输出、固定请求与幂等清理', async () => {
    let calls = 0;
    const synth = create(options({ fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.siliconflow.cn/v1/audio/speech');
      assert.equal(init.redirect, 'error');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer private-test-key');
      assert.deepEqual(JSON.parse(init.body), { model: 'FunAudioLLM/CosyVoice2-0.5B', input: '你好', voice, response_format: 'mp3', sample_rate: 32000, stream: false, speed: 1, gain: -3 });
      return audio();
    } }));
    const result = await synth.synthesize('你好');
    assert.equal(calls, 1);
    assert.equal(path.basename(result.path), 'output.mp3');
    assert.deepEqual(await readFile(result.path), Buffer.from([1, 2, 3]));
    await result.cleanup();
    await result.cleanup();
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('qqbot-speech-')), []);
  });
  await test('认证与付费错误固定脱敏且不读取正文、不重试', async () => {
    for (const [status, code] of [[401, 'SPEECH_AUTH_FAILED'], [403, 'SPEECH_AUTH_FAILED'], [402, 'SPEECH_PAYMENT_REQUIRED'], [429, 'SPEECH_RATE_LIMITED'], [500, 'SPEECH_REQUEST_FAILED']]) {
      let calls = 0;
      await rejects(create(options({ fetchImpl: async () => {
        calls++;
        return { status, ok: false, body: { cancel: async () => {} }, text() { throw new Error('secret-body'); } };
      } })).synthesize('你好'), code);
      assert.equal(calls, 1);
    }
  });
  await test('歌声参考可显式选日常说话，固定指令不计入用户文本长度、不读取任意指令', async () => {
    let calls=0;
    const synth=create(options({speakingStyle:'chat',maxChars:2,fetchImpl:async(_url,init)=>{
      calls++;const body=JSON.parse(init.body);
      assert.equal(body.input,'请自然地说话。<|endofprompt|>你好');
      return audio();
    }}));
    const result=await synth.synthesize('你好');await result.cleanup();assert.equal(calls,1);
    assert.throws(()=>create(options({speakingStyle:'自定义未知指令'})),{code:'SPEECH_INVALID_CONFIG'});
  });
  await test('响应类型、声明大小、实际流大小和空音频检查', async () => {
    for (const response of [
      new Response('abc', { headers: { 'content-type': 'text/plain' } }),
      new Response('abc', { headers: { 'content-type': 'audio/mpeg', 'content-length': '11' } }),
      new Response(new Uint8Array(11), { headers: { 'content-type': 'audio/mpeg' } }),
      new Response(null, { headers: { 'content-type': 'audio/mpeg' } }),
    ]) await rejects(create(options({ maxBytes: 10, fetchImpl: async () => response })).synthesize('你好'), 'SPEECH_INVALID_OUTPUT');
    const result = await create(options({ fetchImpl: async () => new Response('x', { headers: { 'content-type': 'application/octet-stream' } }) })).synthesize('你好');
    await result.cleanup();
  });
  await test('无限空分片不会饿死超时计时器', async () => {
    await rejects(create(options({ timeoutMs: 100, fetchImpl: async () => ({
      ok: true, headers: new Headers({ 'content-type': 'audio/mpeg' }),
      body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array() }), cancel: async () => {}, releaseLock() {} }) },
    }) })).synthesize('你好'), 'SPEECH_INVALID_OUTPUT');
  });
  await test('挂死 fetch 和 reader 都超时并 abort', async () => {
    for (const readerHangs of [false, true]) {
      let signal;
      const start = Date.now();
      await rejects(create(options({ timeoutMs: 100, fetchImpl: async (_url, init) => {
        signal = init.signal;
        if (!readerHangs) return never();
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }), body: { getReader: () => ({ read: never, cancel: never, releaseLock() {} }) } };
      } })).synthesize('你好'), 'SPEECH_TIMEOUT');
      assert.equal(signal.aborted, true);
      assert.ok(Date.now() - start < 1500);
    }
  });
  await test('同一实例只允许一个付费请求，超时后可再次使用', async () => {
    let calls = 0;
    const synth = create(options({ timeoutMs: 100, fetchImpl: async () => { calls++; return calls === 1 ? never() : audio(); } }));
    const pending = synth.synthesize('你好');
    await rejects(synth.synthesize('你好'), 'SPEECH_BUSY');
    await rejects(pending, 'SPEECH_TIMEOUT');
    const result = await synth.synthesize('你好');
    await result.cleanup();
    assert.equal(calls, 2);
  });
  await test('音色、配置与文本在网络前校验，构造无 IO', async () => {
    for (const name of ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana']) assert.equal(validate(`FunAudioLLM/CosyVoice2-0.5B:${name}`), `FunAudioLLM/CosyVoice2-0.5B:${name}`);
    assert.equal(validate('speech:custom:user:abc'), 'speech:custom:user:abc');
    for (const value of ['', 'https://example.com/voice', 'speech:https://example.com/voice', 'speech:has space', 'speech:bad\n', 'speech:', 'speech:' + 'a'.repeat(256), 'FunAudioLLM/CosyVoice2-0.5B:eve']) assert.throws(() => validate(value), { code: 'SPEECH_INVALID_VOICE' });
    assert.doesNotThrow(() => create(options({ apiKeyFile: path.join(root, 'does-not-exist'), fetchImpl: never })));
    assert.throws(() => create(options({ timeoutMs: 0 })), { code: 'SPEECH_INVALID_CONFIG' });
    const synth = create(options({ maxChars: 2, fetchImpl() { assert.fail('不应请求网络'); } }));
    await rejects(synth.synthesize(''), 'SPEECH_INVALID_TEXT');
    await rejects(synth.synthesize('a\0'), 'SPEECH_INVALID_TEXT');
    await rejects(synth.synthesize('三个字'), 'SPEECH_TEXT_TOO_LONG');
  });
  await test('密钥每次读取，拒绝缺失、CRLF 和超限文件', async () => {
    const localKey = path.join(root, 'local-key');
    const synth = create(options({ apiKeyFile: localKey, fetchImpl: async (_url, init) => { assert.equal(init.headers.Authorization, 'Bearer changed-key'); return audio(); } }));
    await rejects(synth.synthesize('你好'), 'SPEECH_KEY_UNAVAILABLE');
    for (const bad of ['', 'private-test-key\n', 'private-test-key\r\n', 'a'.repeat(513)]) {
      await writeFile(localKey, bad);
      await rejects(synth.synthesize('你好'), 'SPEECH_KEY_UNAVAILABLE');
    }
    await writeFile(localKey, 'changed-key');
    const result = await synth.synthesize('你好');
    await result.cleanup();
  });
  await test('清理只删除指定文件，不递归清空目录', async () => {
    const result = await create(options({ fetchImpl: async () => audio() })).synthesize('你好');
    const extra = path.join(path.dirname(result.path), 'keep');
    await mkdir(extra);
    await rejects(result.cleanup(), 'SPEECH_CLEANUP_FAILED');
    assert.deepEqual(await readdir(path.dirname(result.path)), ['keep']);
    await rm(extra, { recursive: true });
    await result.cleanup();
  });
  await test('上传使用固定 FormData，验证返回 URI', async () => {
    const audioPath = path.join(root, 'sample.mp3');
    await writeFile(audioPath, new Uint8Array([1, 2, 3]));
    const uri = await upload({ apiKeyFile: keyFile, audioPath, text: '参考文本', fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.siliconflow.cn/v1/uploads/audio/voice');
      assert.equal(init.redirect, 'error');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer private-test-key');
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get('model'), 'FunAudioLLM/CosyVoice2-0.5B');
      assert.equal(init.body.get('customName'), 'dafeiyu');
      assert.equal(init.body.get('text'), '参考文本');
      assert.equal(init.body.get('file').type, 'audio/mpeg');
      assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), Buffer.from([1, 2, 3]));
      return Response.json({ uri: 'speech:custom:user:abc' });
    } });
    assert.equal(uri, 'speech:custom:user:abc');
    for (const uri of ['https://example.com/voice', voice, 'speech:bad uri']) await rejects(upload({ apiKeyFile: keyFile, audioPath, text: '参考文本', fetchImpl: async () => Response.json({ uri }) }), 'SPEECH_INVALID_OUTPUT');
    await writeFile(audioPath, new Uint8Array(512 * 1024 + 1));
    await rejects(upload({ apiKeyFile: keyFile, audioPath, text: '参考文本', fetchImpl() { assert.fail('超限文件不应上传'); } }), 'SPEECH_INVALID_INPUT');
  });
  await test('上传 JSON 有大小边界，reader 挂死会超时', async () => {
    const audioPath = path.join(root, 'sample-small.mp3');
    await writeFile(audioPath, 'abc');
    await rejects(upload({ apiKeyFile: keyFile, audioPath, text: '文本', fetchImpl: async () => new Response('a'.repeat(32769)) }), 'SPEECH_INVALID_OUTPUT');
    await rejects(upload({ apiKeyFile: keyFile, audioPath, text: '文本', timeoutMs: 100, fetchImpl: async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({ read: never, cancel: never, releaseLock() {} }) } }) }), 'SPEECH_TIMEOUT');
  });
} finally { await rm(root, { recursive: true, force: true }); }
