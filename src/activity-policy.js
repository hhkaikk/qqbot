// 群聊活跃时间及明确呼叫策略。纯函数，所有时段按北京时间判断。
// Beijing calendar, weekends remain normal even on national make-up workdays.
const WAKE_PRIORITY = {
  private: 100, atMention: 90, question: 80, speaker: 75, nameMention: 70,
  keyword: 60, anyMessage: 50, replyCheck: 40, timeout: 30, proactiveCheck: 20,
};

export function wakePriorityV2(reason) {
  return WAKE_PRIORITY[String(reason ?? '').split(':')[0]] ?? 0;
}

export function daytimeQuiet(cfg, key, now = Date.now()) {
  const rule = cfg?.socialV2?.activitySchedule;
  if (rule?.enabled !== true || !String(key).startsWith('group:')) return false;
  const local = new Date(now + 8 * 3600000);
  if (!Number.isFinite(local.getTime())) return true;
  const day = local.getUTCDay();
  if (day === 0 || day === 6 || local.getUTCHours() >= 21) return false;
  const date = local.toISOString().slice(0, 10);
  const ranges = [...(Array.isArray(rule.holidays) ? rule.holidays : []),
    ...(Array.isArray(rule.vacations) ? rule.vacations : [])];
  if (ranges.some(r => Array.isArray(r) && r.length === 2
    && /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && /^\d{4}-\d{2}-\d{2}$/.test(r[1])
    && r[0] <= date && date <= r[1])) return false;
  return true;
}

export function activityWakeAllowed(cfg, key, reason, now = Date.now()) {
  return !daytimeQuiet(cfg, key, now)
    || ['private', 'atMention', 'nameMention', 'admin'].includes(String(reason).split(':')[0]);
}

export function explicitWakeAllowed(cfg, reason, key, now = Date.now()) {
  if (!activityWakeAllowed(cfg, key, reason, now)) return false;
  return cfg?.socialV2?.wake?.directOnly !== true
    || ['private', 'atMention', 'nameMention', 'bootstrap', 'admin'].includes(reason);
}
