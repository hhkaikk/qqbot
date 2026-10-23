// 运行桥接和独立实测共用连接判定，避免同一服务出现两种健康口径。
// true=探测成功，false=已确认未连接，null=读数不足；不返回地址或错误详情。
import { createOneBotHttp } from './onebot-http.js';

export async function probeBotConnections({ gateway, dshApi, bridge }, {
  fetchImpl = globalThis.fetch, timeoutMs = 1800,
} = {}) {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(20, Math.min(8000, timeoutMs)) : 1800;
  const json = async (url, init = {}) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('连接探测 HTTP 失败');
    return response.json();
  };
  const [qq, dsh, bridgeState] = await Promise.all([
    (async () => {
      const call = createOneBotHttp(gateway, { fetchImpl, timeoutMs: timeout });
      const data = await call('get_status');
      if (data?.online === false || data?.good === false) return false;
      return data?.online === true && data?.good === true ? true : null;
    })().catch(() => null),
    (async () => {
      const body = await dshApi.callUnary('settings.describe', {}, AbortSignal.timeout(timeout));
      return typeof body?.result?.ok === 'boolean' ? body.result.ok : null;
    })().catch(() => false),
    (async () => {
      // 在桥接进程内处理命令，进程本身可直接确认；独立脚本须实际请求。
      if (bridge === true) return true;
      if (!bridge?.baseUrl) return null;
      const body = await json(`${String(bridge.baseUrl).replace(/\/+$/, '')}/api/status`, {
        headers: { 'x-console-token': bridge.consoleToken || '' },
      });
      return typeof body?.mode === 'string' && typeof body?.dshReady === 'boolean' ? true : null;
    })().catch(() => null),
  ]);
  return { qq, dsh, bridge: bridgeState };
}
