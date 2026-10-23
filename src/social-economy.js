// 消息展示收据与宿主观察策略；不执行模型调用、不创建轮询或定时唤醒。
export const hostObservationEnabled = cfg => cfg?.socialV2?.economy?.hostObservation === true;

export function unreadPage(st, { limit, afterSeq = null, unseenOnly = false }) {
  const all = Array.isArray(st.unread) ? st.unread : [];
  const unseen = all.filter(m => !Number.isSafeInteger(m.seq) || !st.modelSeenSeqs?.has(m.seq));
  const pool = unseenOnly ? unseen : all;
  const messages = afterSeq !== null ? pool.filter(m => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit)
    : unseenOnly ? pool.slice(0, limit) : pool.slice(-limit);
  return { messages, unseenUnreadCount: unseen.length, omittedSeenCount: unseenOnly ? all.length - unseen.length : 0 };
}

export function beginHostObservation(st, cfg, now = Date.now()) {
  const value = Number(cfg?.socialV2?.economy?.followupWindowMs ?? 30000);
  const duration = Number.isFinite(value) ? Math.max(1000, Math.min(120000, value)) : 30000;
  const previous = st.hostObservation;
  // 单纯看过新消息不等于参与互动，不能每次 followup 都把观察窗往后推。
  if (previous?.token === st.agentToken && st.lastWakeReason === 'followup'
      && Number.isFinite(previous.startedAt) && Number.isFinite(previous.until)
      && !(Number(st.lastAiReplyAt) > previous.startedAt)) return previous.until;
  st.hostObservation = { token: st.agentToken, startedAt: now, until: now + duration };
  return st.hostObservation.until;
}

export function proactiveLocalHour(cfg, now = Date.now()) {
  const timeZone = cfg?.socialV2?.proactive?.timeZone;
  try {
    const value = new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23',
      ...(typeof timeZone === 'string' && timeZone.trim() ? { timeZone: timeZone.trim() } : {}) }).format(new Date(now));
    const hour = Number(value);
    return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
  } catch { return null; }
}

export function hostObservationActive(st, cfg, now = Date.now()) {
  return hostObservationEnabled(cfg) && st?.hostObservation?.token === st?.agentToken
    && Number(st.hostObservation?.until) > now;
}
