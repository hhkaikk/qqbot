// OneBot HTTP 的固定连接配置；不记录或透传网关正文、URL、令牌及原始异常。
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const timeoutFor = value => Number.isFinite(value) ? Math.max(20, Math.min(30000, value)) : 15000;

/**
 * 返回 call(action, params?, { timeoutMs? }?)，成功直接返回 data（包括 false/0/null）。
 * 工厂快照连接配置；连接自愈或令牌更新后重新创建。fetchImpl 仅用于隔离测试。
 */
export function createOneBotHttp(gateway = {}, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const baseUrl = String(gateway?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = gateway?.accessToken;
  const headers = { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const defaultTimeout = timeoutFor(timeoutMs);

  return async function call(action, params = {}, { timeoutMs: requestTimeout = defaultTimeout } = {}) {
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(action)) {
      throw failure('ONEBOT_REQUEST', 'OneBot 请求动作无效');
    }
    let body;
    try { body = JSON.stringify(params); }
    catch { throw failure('ONEBOT_REQUEST', 'OneBot 请求参数无法编码'); }
    const signal = AbortSignal.timeout(Math.trunc(timeoutFor(requestTimeout)));
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${action}`, { method: 'POST', headers: { ...headers }, body, signal });
    } catch {
      throw signal.aborted ? failure('ONEBOT_TIMEOUT', 'OneBot 请求超时')
        : failure('ONEBOT_NETWORK', 'OneBot 连接失败');
    }
    if (!response.ok) {
      throw failure('ONEBOT_HTTP', 'OneBot HTTP 请求失败',
        Number.isInteger(response.status) ? { httpStatus: response.status } : {});
    }
    let receipt;
    try { receipt = await response.json(); }
    catch {
      throw signal.aborted ? failure('ONEBOT_TIMEOUT', 'OneBot 请求超时')
        : failure('ONEBOT_RECEIPT', 'OneBot 回执格式无效');
    }
    if (receipt?.status !== 'ok' || receipt.retcode !== 0) {
      throw failure('ONEBOT_RECEIPT', 'OneBot 请求未成功');
    }
    if (!Object.hasOwn(receipt, 'data')) throw failure('ONEBOT_RECEIPT', 'OneBot 回执缺少 data');
    return receipt.data;
  };
}
