import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSpeechSynthesizer } from '../src/speech-output.js';

const root = await mkdtemp(path.join(tmpdir(), 'speech-output-test-'));
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`通过：${name}`); };
const errorCode = code => error => error.code === code;
function fakeSpawn(behavior = 'success', bytes = 5) {
  const calls = [];
  const spawn = (python, args, options) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = signal => { child.kills.push(signal); if (behavior !== 'stubborn') setImmediate(() => child.emit('close', null, signal)); return true; };
    child.kills = [];
    calls.push({ python, args, options, child });
    setImmediate(() => {
      if (behavior === 'hang' || behavior === 'stubborn') return;
      if (behavior === 'error') { child.emit('error', new Error('private secret')); return; }
      if (behavior !== 'missing') writeFileSync(args[args.indexOf('--write-media') + 1], Buffer.alloc(bytes, 1));
      child.stderr.write('private secret'.repeat(10000));
      child.emit('close', behavior === 'failure' ? 1 : 0);
    });
    return child;
  };
  return Object.assign(spawn, { calls });
}
const make = (spawnImpl, extra = {}) => createSpeechSynthesizer({ python: 'python-test', tempDir: root, spawnImpl, ...extra });
const empty = async () => assert.deepEqual(await readdir(root), []);
try {
  await test('构造无文件 IO，成功结果与幂等清理、私有文本及参数', async () => {
    const fake = fakeSpawn();
    const synth = make(fake);
    await empty();
    const text = '你好，私密文本 $()';
    const result = await synth.synthesize(text);
    const call = fake.calls[0];
    assert.equal(call.python, 'python-test');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.args.includes(text), false);
    assert.deepEqual(call.args.slice(0, 4), ['-m', 'edge_tts', '--voice', 'zh-CN-XiaoxiaoNeural']);
    assert(call.args.includes('--no-progress'));
    const textPath = call.args[call.args.indexOf('--file') + 1];
    assert.equal(await readFile(textPath, 'utf8'), text);
    assert.equal((await stat(result.path)).size, 5);
    if (process.platform !== 'win32') {
      assert.equal((await stat(textPath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(result.path))).mode & 0o777, 0o700);
    }
    await result.cleanup(); await result.cleanup(); await empty();
  });
  await test('空白、超长及非法 voice 拒绝且不启动进程', async () => {
    const fake = fakeSpawn();
    const synth = make(fake, { maxChars: 2 });
    await assert.rejects(synth.synthesize('  \n'), errorCode('SPEECH_INVALID_TEXT'));
    await assert.rejects(synth.synthesize('你好呀'), errorCode('SPEECH_TEXT_TOO_LONG'));
    assert.throws(() => make(fake, { voice: 'zh-CN-XiaoxiaoNeural;evil' }), errorCode('SPEECH_INVALID_VOICE'));
    assert.equal(fake.calls.length, 0); await empty();
  });
  for (const behavior of ['failure', 'error', 'missing']) await test(`${behavior} 失败不泄露 stderr 并清理`, async () => {
    await assert.rejects(make(fakeSpawn(behavior)).synthesize('你好'), error => !error.message.includes('private secret'));
    await empty();
  });
  for (const bytes of [0, 11]) await test(`拒绝无效输出大小 ${bytes}`, async () => {
    await assert.rejects(make(fakeSpawn('success', bytes), { maxBytes: 10 }).synthesize('你好'), errorCode('SPEECH_INVALID_OUTPUT'));
    await empty();
  });
  await test('同步 spawn 异常清理并释放并发位', async () => {
    let attempts = 0;
    const successfulSpawn = fakeSpawn();
    const synth = make((...args) => {
      if (attempts++ === 0) throw new Error('private secret');
      return successfulSpawn(...args);
    });
    await assert.rejects(synth.synthesize('你好'), errorCode('SPEECH_PROCESS_FAILED'));
    await empty();
    const result = await synth.synthesize('再次');
    await result.cleanup(); await empty();
  });
  await test('精确字符和字节边界不截断文本', async () => {
    const fake = fakeSpawn('success', 10);
    const result = await make(fake, { maxChars: 2, maxBytes: 10 }).synthesize('你😀');
    const args = fake.calls[0].args;
    assert.equal(await readFile(args[args.indexOf('--file') + 1], 'utf8'), '你😀');
    await result.cleanup(); await empty();
  });
  for (const behavior of ['hang', 'stubborn']) await test(`${behavior} 超时有界 kill、清理并释放并发位`, async () => {
    const fake = fakeSpawn(behavior);
    const synth = make(fake, { timeoutMs: 20 });
    const pending = synth.synthesize('你好');
    await assert.rejects(synth.synthesize('第二条'), errorCode('SPEECH_BUSY'));
    const started = Date.now();
    await assert.rejects(pending, errorCode('SPEECH_TIMEOUT'));
    assert(Date.now() - started < 2000);
    assert(fake.calls[0].child.kills.length >= 1);
    await empty();
    await assert.rejects(synth.synthesize('再次'), errorCode('SPEECH_TIMEOUT'));
    await empty();
  });
  await test('合成成功释放并发位，可同时保留两个结果', async () => {
    const synth = make(fakeSpawn());
    const first = await synth.synthesize('一');
    const second = await synth.synthesize('二');
    assert.notEqual(first.path, second.path);
    await first.cleanup(); await second.cleanup(); await empty();
  });
  console.log(`语音输出模块：${count} 项通过`);
} finally {
  await rm(root, { recursive: true, force: true });
}
