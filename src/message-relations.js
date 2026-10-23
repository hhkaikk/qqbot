import { memberQQ } from './member-memory.js';
const ref = value => /^-?[A-Za-z0-9_:-]{1,64}$/.test(String(value ?? '').trim()) ? String(value).trim() : null;

export function relationRefs(message) {
  const mentions = [], replies = [];
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment?.type === 'at') mentions.push(segment.data?.qq);
      if (segment?.type === 'reply') replies.push(segment.data?.id);
    }
  } else if (typeof message === 'string') {
    for (const match of message.matchAll(/\[CQ:at,qq=([1-9]\d*)\]/g)) mentions.push(match[1]);
    for (const match of message.matchAll(/\[CQ:reply,id=(-?\d+)(?:,[^\]]*)?\]/g)) replies.push(match[1]);
  }
  return { mentionedUserIds: [...new Set(mentions.map(memberQQ).filter(Boolean))].slice(0,20),
    replyMessageId: ref(replies[0]) };
}

export function messageRelations(st, messageId, context = {}) {
  const result = {};
  const id = ref(messageId);
  if (id) result.threadId = `msg:${id}`;
  const mentions = [...new Set((Array.isArray(context.mentionedUserIds) ? context.mentionedUserIds : []).map(memberQQ).filter(Boolean))].slice(0,20);
  if (mentions.length) result.mentionedUserIds = mentions;
  const reply = context.replyTo;
  const target = ref(reply?.messageId);
  if (target) {
    result.replyTo = { messageId: target, userId: memberQQ(reply.userId),
      ...(reply.sender ? { sender: String(reply.sender).slice(0,64) } : {}),
      ...(typeof reply.isSelf === 'boolean' ? { isSelf: reply.isSelf } : {}), resolved: reply.resolved !== false && !!memberQQ(reply.userId) };
    const recent = st.recentMessages || [];
    const parent = recent.find(m => m.messageId != null && String(m.messageId) === target)
      || (ref(reply.parentMessageId) ? recent.find(m => m.messageId != null && String(m.messageId) === String(reply.parentMessageId)) : null);
    result.threadId = parent?.threadId || (parent?.messageId ? `msg:${parent.messageId}` : `msg:${target}`);
  }
  return result;
}

export function messageFocus(messages, recent = []) {
  const pool = messages; // 历史仅供背景，不能把已回复过的旧 @ 重新当成本轮提问。
  const incoming = pool.filter(m => m && !m.isSelf);
  const message = [...incoming].reverse().find(m => m.atSelf || m.quoteTargetIsSelf) || incoming.at(-1);
  if (!message) return null;
  return { seq: message.seq ?? null, messageId: message.messageId ?? null, userId: message.userId ?? null,
    threadId: message.threadId ?? null, ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.mentionedUserIds?.length ? { mentionedUserIds: message.mentionedUserIds } : {}) };
}
