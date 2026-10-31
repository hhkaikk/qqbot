// 控制台 Token 用量路由。认证仍由主入口执行，这里保留跨会话管理信息的额外隔离。
// 注入账本和响应函数，避免路由依赖桥接运行态、磁盘或连接。
// 调用者须先完成会话令牌、白名单和工具开关校验；这里只返回指定会话的最小汇总。
export async function readConversationTokenUsage(ledger, key) {
  const note = '本群或当前私聊的已记录累计用量，不是今日用量；尚未结算的请求可能未计入。费用按配置价目表估算。';
  const unavailable = { available: false, scope: 'current_conversation', period: 'recorded_total', totalTokens: null, inputTokens: null, outputTokens: null, estimatedCost: null, note };
  try {
    const detail = await ledger.conversation(key, { turnLimit: 1 });
    const buckets = detail?.buckets;
    if (!detail || !buckets || !['cacheMiss', 'cacheHit', 'cacheWrite', 'output'].every(k => Number.isFinite(buckets[k]) && buckets[k] >= 0)) return unavailable;
    const inputTokens = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
    return { available: true, scope: 'current_conversation', period: 'recorded_total',
      generatedAt: detail.generatedAt, totalTokens: inputTokens + buckets.output, inputTokens,
      outputTokens: buckets.output, cacheHitTokens: buckets.cacheHit,
      estimatedCost: Number.isFinite(detail.cost) ? { amount: detail.cost, currency: detail.currency } : null,
      note };
  } catch { return unavailable; }
}

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
