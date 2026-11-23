// 离线补投只合并可重建快照的唤醒；普通消息、附件及特殊回合是顺序屏障。
import { wakePriorityV2 } from './activity-policy.js';

const directReasons = new Set(['private', 'atMention', 'nameMention', 'admin']);
const baseReason = item => String(item.wakeReason ?? '').split(':')[0];
const mergeable = item => Boolean(item.wakeReason) && baseReason(item) !== 'bootstrap'
  && !item.farewell && !item.silent && !(item.media?.length);

function preferredWake(previous, next) {
  const previousDirect = directReasons.has(baseReason(previous));
  const nextDirect = directReasons.has(baseReason(next));
  if (previousDirect !== nextDirect) return nextDirect ? next : previous;
  return wakePriorityV2(next.wakeReason) >= wakePriorityV2(previous.wakeReason) ? next : previous;
}

/** 按时间顺序合并两批待投递请求，不改输入；容量上限沿用桥接的 50 条。 */
export function mergeOfflinePrompts(previous, incoming, maxItems = 50) {
  const items = [];
  let coalesced = 0;
  for (const item of [...previous, ...incoming]) {
    const last = items.at(-1);
    if (last && mergeable(last) && mergeable(item)) {
      items[items.length - 1] = preferredWake(last, item);
      coalesced++;
    } else items.push(item);
  }
  const dropped = Math.max(0, items.length - maxItems);
  return { items: items.slice(dropped), dropped, coalesced };
}
