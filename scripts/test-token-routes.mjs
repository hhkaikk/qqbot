// 纯 mock 验证控制台 Token 路由，不启动桥接、不读取账本或连接外部服务。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenRoutes } from '../src/token-routes.js';

function fixture(overrides = {}) {
  const calls = [];
  const responses = [];
  const ledger = Object.fromEntries(['summary', 'stats', 'series', 'conversation', 'recent', 'reset'].map((name) => [name, (...args) => {
    calls.push([name, ...args]);
    return ({ summary: { ok: true, total: 12 }, stats: { lines: 3 }, series: { ok: true, buckets: [] }, conversation: { ok: true, turns: [] }, recent: [] })[name];
  }]));
  Object.assign(ledger, overrides.ledger);
  const handle = createTokenRoutes({
    ledger,
    sendJson: (body, status = 200) => responses.push({ body, status }),
    getSymbol: () => '¥',
    log: (message) => calls.push(['log', message]),
    ...overrides,
    ledger,
  });
  const request = (path, method = 'GET', headers = {}) => handle({ method, headers }, new URL(path, 'http://localhost'));
  return { calls, responses, request };
}

test('非 Token 路径交回主程序，包括相似前缀', async () => {
  const f = fixture();
  for (const path of ['/api/socialV2/status', '/api/tokens', '/api/tokens-other/summary']) {
    assert.equal(await f.request(path, 'POST', { 'x-agent-token': 'agent' }), false);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.responses, []);
});

test('所有 Token 路径先拒绝 agent，再访问账本或价格', async () => {
  for (const path of ['summary', 'series', 'turns', 'recent', 'reset', 'unknown']) {
    for (const method of ['GET', 'POST']) {
      const f = fixture({
        ledger: Object.fromEntries(['summary', 'stats', 'series', 'conversation', 'recent', 'reset'].map((name) => [name, () => { throw new Error('拒绝之前访问了账本'); }])),
        getSymbol() { throw new Error('拒绝之前访问了价格'); },
      });
      assert.equal(await f.request(`/api/tokens/${path}`, method, { 'x-agent-token': 'agent' }), true);
      assert.deepEqual(f.responses, [{ body: { ok: false, error: '该接口仅控制台可用' }, status: 403 }]);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('summary 保留返回结构和查询上下界、默认值', async () => {
  for (const [query, limit] of [['', 200], ['?limit=bad', 200], ['?limit=0', 200], ['?limit=-5', 1], ['?limit=9999', 500], ['?limit=17.5', 17.5]]) {
    const f = fixture();
    assert.equal(await f.request(`/api/tokens/summary${query}`), true);
    assert.deepEqual(f.calls, [['summary', { limit }], ['stats']]);
    assert.deepEqual(f.responses, [{ body: { ok: true, total: 12, ledger: { lines: 3 } }, status: 200 }]);
  }
});

test('series 保留小时和桶数范围，原样返回数据', async () => {
  for (const [query, hours, maxBuckets] of [['', 24, 48], ['?hours=bad&buckets=0', 24, 48], ['?hours=-3&buckets=1', 1, 6], ['?hours=9999&buckets=999', 2160, 120], ['?hours=72&buckets=20', 72, 20]]) {
    const f = fixture();
    assert.equal(await f.request(`/api/tokens/series${query}`), true);
    assert.deepEqual(f.calls, [['series', { hours, maxBuckets }]]);
    assert.deepEqual(f.responses[0], { body: { ok: true, buckets: [] }, status: 200 });
  }
});

test('turns 去掉 key 两端空格并保留默认值和查询范围', async () => {
  for (const [query, key, turnLimit] of [['', '', 200], ['?key=%20group%3A42%20&limit=3000', 'group:42', 1000], ['?limit=-1', '', 1], ['?limit=bad', '', 200]]) {
    const f = fixture();
    assert.equal(await f.request(`/api/tokens/turns${query}`), true);
    assert.deepEqual(f.calls, [['conversation', key, { turnLimit }]]);
    assert.deepEqual(f.responses[0], { body: { ok: true, turns: [] }, status: 200 });
  }
});

test('turns 空会话由账本判定并返回原有 404', async () => {
  const f = fixture({ ledger: { conversation: () => null } });
  assert.equal(await f.request('/api/tokens/turns'), true);
  assert.deepEqual(f.responses, [{ body: { ok: false, error: '未找到该会话的用量记录' }, status: 404 }]);
});

test('recent 保留价格符号、entries 和 limit 范围', async () => {
  let symbol = '¥';
  const f = fixture({ getSymbol: () => symbol });
  for (const [query, limit] of [['', 50], ['?limit=0', 50], ['?limit=-2', 1], ['?limit=900', 500], ['?limit=23', 23]]) {
    symbol = `$${limit}`;
    assert.equal(await f.request(`/api/tokens/recent${query}`), true);
    assert.deepEqual(f.calls.at(-1), ['recent', limit]);
    assert.deepEqual(f.responses.at(-1), { body: { ok: true, symbol, entries: [] }, status: 200 });
  }
});

test('reset 仅 POST 执行，且记录原有日志', async () => {
  const f = fixture();
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
    assert.equal(await f.request('/api/tokens/reset', method), true);
    assert.deepEqual(f.responses.at(-1), { body: { ok: false, error: 'not found' }, status: 404 });
  }
  assert.deepEqual(f.calls, []);
  assert.equal(await f.request('/api/tokens/reset', 'POST'), true);
  assert.deepEqual(f.calls, [['reset'], ['log', '控制台：token 用量账本已重置']]);
  assert.deepEqual(f.responses.at(-1), { body: { ok: true }, status: 200 });
});

test('未知 Token 路由及读路由错误方法仍返回 404', async () => {
  const f = fixture();
  for (const path of ['summary', 'series', 'turns', 'recent', 'unknown']) {
    assert.equal(await f.request(`/api/tokens/${path}`, 'POST'), true);
    assert.deepEqual(f.responses.at(-1), { body: { ok: false, error: 'not found' }, status: 404 });
  }
  assert.deepEqual(f.calls, []);
});

test('账本同步和异步异常向调用者传播，不误报成功', async () => {
  const failure = new Error('测试账本异常');
  for (const [path, method, operation] of [['summary', 'GET', 'summary'], ['summary', 'GET', 'stats'], ['series', 'GET', 'series'], ['turns', 'GET', 'conversation'], ['recent', 'GET', 'recent'], ['reset', 'POST', 'reset']]) {
    for (const fail of [() => { throw failure; }, async () => { throw failure; }]) {
      const f = fixture({ ledger: { [operation]: fail } });
      await assert.rejects(f.request(`/api/tokens/${path}`, method), (error) => error === failure);
      assert.deepEqual(f.responses, []);
    }
  }
});

test('异步账本返回值会等待完成后组装响应', async () => {
  const f = fixture({ ledger: {
    summary: async () => ({ ok: true, total: 8 }),
    stats: async () => ({ lines: 2 }),
    conversation: async () => null,
    recent: async () => [{ id: 'sample' }],
  } });
  await f.request('/api/tokens/summary');
  assert.deepEqual(f.responses.at(-1).body, { ok: true, total: 8, ledger: { lines: 2 } });
  await f.request('/api/tokens/turns');
  assert.equal(f.responses.at(-1).status, 404);
  await f.request('/api/tokens/recent');
  assert.deepEqual(f.responses.at(-1).body.entries, [{ id: 'sample' }]);
});
