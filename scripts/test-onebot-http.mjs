// 统一 OneBot HTTP 契约：仅使用模拟 fetch，不连接或发送真实 QQ 消息。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOneBotHttp } from '../src/onebot-http.js';

const gateway = { httpUrl: 'http://gateway.invalid/api///', accessToken: 'fixture-secret-token' };
const receipt = data => ({ ok: true, status: 200,
  json: async () => ({ status: 'ok', retcode: 0, data }) });
const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const assertSafe = error => {
  const exposed = `${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of ['fixture-secret-token', 'gateway.invalid', 'private-body', 'private-wording']) {
    assert.ok(!exposed.includes(secret), `错误不得包含 ${secret}`);
  }
  assert.equal(error.cause, undefined);
  return true;
};

test('固定地址、鉴权和 JSON 参数，禁止逐请求覆盖连接配置', async () => {
  const config = { ...gateway };
  const calls = [];
  const call = createOneBotHttp(config, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return receipt({ message_id: -123 });
  } });
  config.httpUrl = 'http://changed.invalid';
  config.accessToken = 'changed-token';
  assert.deepEqual(await call('send_private_msg', { user_id: 123, message: 'hello' }, {
    httpUrl: 'http://override.invalid', accessToken: 'override-token',
  }), { message_id: -123 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://gateway.invalid/api/send_private_msg');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, {
    'content-type': 'application/json', authorization: 'Bearer fixture-secret-token',
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), { user_id: 123, message: 'hello' });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('未配置 token 时不发送空 Bearer；空参数仍是 JSON 对象', async () => {
  const call = createOneBotHttp({}, { fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:3000/get_status');
    assert.equal(Object.hasOwn(init.headers, 'authorization'), false);
    assert.equal(init.body, '{}');
    return receipt({ online: false, good: false });
  } });
  assert.deepEqual(await call('get_status'), { online: false, good: false });
});

test('有效 data 保留 false、0 和 null；缺 data 不冒充成功', async () => {
  for (const data of [false, 0, null, '', [], {}]) {
    const call = createOneBotHttp(gateway, { fetchImpl: async () => receipt(data) });
    assert.deepEqual(await call('get_status'), data);
  }
  const call = createOneBotHttp(gateway, { fetchImpl: async () => ({ ok: true,
    json: async () => ({ status: 'ok', retcode: 0 }) }) });
  await assert.rejects(call('get_status'), error => error.code === 'ONEBOT_RECEIPT' && assertSafe(error));
});

test('HTTP 失败保留数值状态，但不读取或暴露响应正文', async () => {
  let bodyReads = 0;
  const call = createOneBotHttp(gateway, { fetchImpl: async () => ({ ok: false, status: 426,
    json: async () => { bodyReads++; throw new Error('private-body'); } }) });
  await assert.rejects(call('send_private_msg', { message: 'private-body' }), error => {
    assert.equal(error.code, 'ONEBOT_HTTP');
    assert.equal(error.httpStatus, 426);
    return assertSafe(error);
  });
  assert.equal(bodyReads, 0);
});

test('OneBot 业务失败、非标准回执及 JSON 解析错误均拒绝且隐藏正文', async () => {
  for (const body of [
    { status: 'failed', retcode: 100, wording: 'private-wording', data: 'private-body' },
    { status: 'ok', retcode: '0', data: {} },
    { status: 'async', retcode: 1, data: {} }, null, [],
  ]) {
    const call = createOneBotHttp(gateway, { fetchImpl: async () => ({ ok: true, json: async () => body }) });
    await assert.rejects(call('get_status'), assertSafe);
  }
  const call = createOneBotHttp(gateway, { fetchImpl: async () => ({ ok: true,
    json: async () => { throw new Error('private-body fixture-secret-token http://gateway.invalid'); } }) });
  await assert.rejects(call('get_status'), error => error.code === 'ONEBOT_RECEIPT' && assertSafe(error));
});

test('网络和请求序列化异常不会泄露原始异常、地址、token 或参数', async () => {
  const call = createOneBotHttp(gateway, { fetchImpl: async () => {
    throw new Error('http://gateway.invalid fixture-secret-token private-body');
  } });
  await assert.rejects(call('get_status'), error => error.code === 'ONEBOT_NETWORK' && assertSafe(error));
  const cyclic = { value: 'private-body' };
  cyclic.self = cyclic;
  await assert.rejects(call('get_status', cyclic), assertSafe);
});

test('action 不能注入 URL、查询参数或其他路径', async () => {
  let called = false;
  const call = createOneBotHttp(gateway, { fetchImpl: async () => { called = true; return receipt({}); } });
  for (const action of ['http://gateway.invalid', '../get_status', '/get_status', 'get_status?token=fixture-secret-token', '']) {
    await assert.rejects(call(action), assertSafe);
  }
  assert.equal(called, false);
});

test('短超时覆盖请求和响应读取，可逐请求设置且每次使用独立信号', async () => {
  // AbortSignal.timeout 不保持事件循环；哨兵只保证测试可等到 abort。
  const sentinel = setTimeout(() => {}, 2000);
  try {
    for (const readingBody of [false, true]) {
      let signal;
      const call = createOneBotHttp(gateway, { timeoutMs: 1000, fetchImpl: async (_url, init) => {
        signal = init.signal;
        if (!readingBody) return waitForAbort(signal);
        return { ok: true, json: () => waitForAbort(signal) };
      } });
      const started = Date.now();
      await assert.rejects(call('get_status', {}, { timeoutMs: 40 }), error => {
        assert.equal(error.code, 'ONEBOT_TIMEOUT');
        return assertSafe(error);
      });
      assert.equal(signal.aborted, true);
      assert.ok(Date.now() - started < 1000);
    }
  } finally { clearTimeout(sentinel); }
});
