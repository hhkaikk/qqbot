// 控制台 Token 用量路由。认证仍由主入口执行，这里保留跨会话管理信息的额外隔离。
// 注入账本和响应函数，避免路由依赖桥接运行态、磁盘或连接。
export function createTokenRoutes({ ledger, sendJson, getSymbol, log = () => {} }) {
  return async function handle(req, url) {
    if (!url.pathname.startsWith('/api/tokens/')) return false;

    // 必须先检查权限，不能先读取账本或价目表。
    if (req.headers['x-agent-token']) {
      await sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const summary = await ledger.summary({ limit });
      const stats = await ledger.stats();
      await sendJson({ ...summary, ledger: stats });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
      await sendJson(await ledger.series({ hours, maxBuckets }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const detail = await ledger.conversation(key, { turnLimit: limit });
      if (!detail) {
        await sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404);
        return true;
      }
      await sendJson(detail);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const symbol = await getSymbol();
      await sendJson({ ok: true, symbol, entries: await ledger.recent(limit) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
      await ledger.reset();
      await log('控制台：token 用量账本已重置');
      await sendJson({ ok: true });
      return true;
    }
    await sendJson({ ok: false, error: 'not found' }, 404);
    return true;
  };
}
