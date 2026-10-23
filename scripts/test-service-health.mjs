// 运行入口与实测脚本共用的连接探测契约，不连接 QQ 或 DSH。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeBotConnections } from '../src/service-health.js';

const gateway = { httpUrl: 'http://gateway.invalid/', accessToken: 'fixture-only' };
const response = (data, ok = true) => ({ ok, json: async () => data });
const qq = data => response({ status: 'ok', retcode: 0, data });
const dshApi = { callUnary: async method => {
  assert.equal(method, 'settings.describe');
  return { result: { ok: true, value: { namespaces: [] } } };
} };

test('连接探测使用实际协议，并保留固定 OneBot 地址与鉴权', async () => {
  const calls = [];
  const result = await probeBotConnections({ gateway, dshApi, bridge: true }, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return qq({ online: true, good: true });
  } });
  assert.deepEqual(result, { qq: true, dsh: true, bridge: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://gateway.invalid/get_status');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-only');
});

test('调用方未提供桥接存活依据时保持未知', async () => {
  const result = await probeBotConnections({ gateway, dshApi }, { fetchImpl: async () => qq({ online: true, good: true }) });
  assert.equal(result.bridge, null);
});

test('QQ 在线和接收链路分别判断，缺失字段保持未知', async () => {
  for (const [data, expected] of [
    [{ online: true, good: true }, true], [{ online: false, good: true }, false],
    [{ online: true, good: false }, false], [{ online: true }, null], [{}, null],
  ]) {
    const result = await probeBotConnections({ gateway, dshApi }, { fetchImpl: async () => qq(data) });
    assert.equal(result.qq, expected);
    assert.equal(result.dsh, true);
  }
});

test('HTTP 或 OneBot 业务失败不会冒充 QQ 在线', async () => {
  for (const reply of [response({ status: 'ok', retcode: 0, data: { online: true, good: true } }, false),
    response({ status: 'failed', retcode: 100, data: { online: true, good: true } }),
    { ok: true, json: async () => { throw new Error('invalid json'); } }]) {
    const result = await probeBotConnections({ gateway, dshApi }, { fetchImpl: async () => reply });
    assert.equal(result.qq, null);
    assert.equal(result.dsh, true);
  }
});

test('DSH 拒绝和不可达显示未连接，异常信封显示未知', async () => {
  for (const [callUnary, expected] of [
    [async () => ({ result: { ok: false, error: { code: 'unavailable' } } }), false],
    [async () => { throw new Error('connection refused'); }, false],
    [async () => ({}), null],
  ]) {
    const result = await probeBotConnections({ gateway, dshApi: { callUnary } }, {
      fetchImpl: async () => qq({ online: true, good: true }),
    });
    assert.equal(result.dsh, expected);
    assert.equal(result.qq, true);
  }
});

test('独立脚本检查桥接真实返回格式，不要求不存在的 ok 字段', async () => {
  const calls = [];
  const result = await probeBotConnections({ gateway, dshApi,
    bridge: { baseUrl: 'http://bridge.invalid/', consoleToken: 'fixture-console' } }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith('/get_status') ? qq({ online: true, good: true })
        : response({ mode: 'reserved2', dshReady: false });
    },
  });
  assert.equal(result.bridge, true, 'DSH 暂不可用不等于桥接进程不可用');
  const call = calls.find(c => c.url.endsWith('/api/status'));
  assert.equal(call.init.headers['x-console-token'], 'fixture-console');
});

test('桥接错误页面保持未知，不受其他正常连接影响', async () => {
  const result = await probeBotConnections({ gateway, dshApi, bridge: { baseUrl: 'http://bridge.invalid' } }, {
    fetchImpl: async url => url.endsWith('/get_status') ? qq({ online: true, good: true }) : response({ error: 'no' }),
  });
  assert.deepEqual(result, { qq: true, dsh: true, bridge: null });
});

test('所有外部探测都有取消信号与短超时', async () => {
  const waitForAbort = signal => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // AbortSignal.timeout 自身不保持事件循环存活；测试哨兵不改变探测超时行为。
  const sentinel = setTimeout(() => {}, 2000);
  try {
    const started = Date.now();
    const result = await probeBotConnections({ gateway,
      dshApi: { callUnary: (_method, _args, signal) => waitForAbort(signal) },
      bridge: { baseUrl: 'http://bridge.invalid' } }, {
      timeoutMs: 80, fetchImpl: (_url, init) => waitForAbort(init.signal),
    });
    assert.deepEqual(result, { qq: null, dsh: false, bridge: null });
    assert.ok(Date.now() - started < 1000);
  } finally { clearTimeout(sentinel); }
});
