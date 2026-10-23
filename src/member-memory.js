// 会话内的成员身份目录与印象；不联网、不跨会话推断身份。
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const safeName = value => String(value ?? '').trim().slice(0, 64);
const blocked = name => ['__proto__', 'constructor', 'prototype'].includes(name);
export const memberQQ = value => /^[1-9]\d{0,19}$/.test(String(value ?? '').trim()) ? String(value).trim() : null;
const keyQQ = value => memberQQ(String(value ?? '').replace(/^qq:/, ''));
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const aliasesOf = (...values) => [...new Set(values.flat().map(safeName).filter(x => x && !blocked(x)))].slice(-10);
const legacyKey = (name, occupied) => {
  const base = `legacy:${name}`;
  let key = base, suffix = 1;
  while (occupied(key)) key = `${base}:${suffix++}`;
  return key;
};

export function observeMember(st, userId, displayName, now = Date.now()) {
  const id = memberQQ(userId);
  if (!id) return;
  st.memberDirectory ||= Object.create(null);
  const previous = own(st.memberDirectory, id) ? st.memberDirectory[id] : {};
  const name = safeName(displayName) || previous.displayName || `QQ ${id}`;
  const aliases = aliasesOf(previous.aliases || [], previous.displayName, name);
  st.memberDirectory[id] = { displayName: name, aliases, lastSeenAt: now };
  const im = st.memberImpressions?.[`qq:${id}`];
  if (im && memberQQ(im.userId) === id) Object.assign(im, { userId: id, displayName: name, aliases: aliasesOf(im.aliases || [], aliases) });
  const entries = Object.entries(st.memberDirectory);
  if (entries.length > 200) {
    entries.sort((a,b) => Number(a[1].lastSeenAt || 0) - Number(b[1].lastSeenAt || 0));
    for (const [key] of entries.slice(0, entries.length - 200)) delete st.memberDirectory[key];
  }
}

export function restoreMemberMemory(st, conversationKey) {
  const directory = st.memberDirectory || {};
  st.memberDirectory = Object.create(null);
  for (const [id, value] of Object.entries(directory)) {
    if (!memberQQ(id) || !value || typeof value !== 'object') continue;
    observeMember(st, id, value.displayName, Number(value.lastSeenAt) || 0);
    if (st.memberDirectory[id]) st.memberDirectory[id].aliases = aliasesOf(value.aliases || [], value.displayName);
  }
  for (const msg of st.recentMessages || []) if (!msg?.isSelf) observeMember(st, msg?.userId, msg?.sender, Number(msg?.time) || 0);
  const clean = Object.create(null);
  const peer = /^private:([1-9]\d*)$/.exec(conversationKey)?.[1];
  if (peer && !st.memberDirectory[peer]) observeMember(st, peer, `私聊 ${peer}`, 0);
  for (const [name, raw] of Object.entries(st.memberImpressions || {})) {
    if (blocked(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = memberQQ(raw.userId)
      || (peer && [peer, `私聊 ${peer}`, `private:${peer}`].includes(name) ? peer : null);
    const entry = { ...raw, traits: Array.isArray(raw.traits) ? raw.traits.map(x => String(x).slice(0,50)).slice(-20) : [] };
    if (!id) {
      // 老版本允许任意昵称。仅有 qq: 前缀不是身份证据，也不能占用新稳定键。
      const key = name.startsWith('qq:') ? legacyKey(name, k => own(clean,k) || own(st.memberImpressions,k)) : name;
      clean[key] = name.startsWith('qq:') ? { ...entry, legacyName: raw.legacyName || name } : entry;
      continue;
    }
    const profile = st.memberDirectory[id];
    const displayName = profile?.displayName || safeName(raw.displayName) || (!name.startsWith('qq:') ? name : `QQ ${id}`);
    const old = clean[`qq:${id}`];
    clean[`qq:${id}`] = { ...entry, userId: id, displayName,
      aliases: aliasesOf(old?.aliases || [], raw.aliases || [], profile?.aliases || [], displayName),
      traits: [...new Set([...(old?.traits || []), ...entry.traits])].slice(-20),
      interactionCount: (Number(old?.interactionCount) || 0) + (Number(entry.interactionCount) || 0) };
  }
  st.memberImpressions = clean;
}

export function resolveMember(st, { target, userId, allowLegacy = false } = {}) {
  const name = String(target ?? '').trim().slice(0,128); // 兼容带命名空间的旧记录键。
  if (blocked(name)) fail('非法的群友名字');
  const explicit = userId !== undefined && userId !== null && String(userId).trim() !== '';
  if (!explicit && allowLegacy && own(st.memberImpressions, name) && !st.memberImpressions[name]?.userId) return { key: name, legacy: true };
  const id = explicit ? memberQQ(userId) : keyQQ(name);
  if (explicit && !id) fail('userId 必须是有效 QQ 号');
  if (id) {
    const saved = st.memberImpressions?.[`qq:${id}`];
    const profile = st.memberDirectory?.[id] || (memberQQ(saved?.userId) === id ? saved : null);
    if (!profile) fail('当前会话没有该 QQ 身份证据，请从本会话消息或活跃成员取得 userId');
    return { key: `qq:${id}`, userId: id, displayName: profile.displayName || `QQ ${id}`, aliases: profile.aliases || [] };
  }
  if (!name) fail('请提供 userId 或唯一昵称');
  const matches = new Map();
  for (const [id, profile] of Object.entries(st.memberDirectory || {})) {
    if (profile.displayName === name || profile.aliases?.includes(name)) matches.set(id, profile);
  }
  for (const entry of Object.values(st.memberImpressions || {})) {
    if (memberQQ(entry?.userId) && (entry.displayName === name || entry.aliases?.includes(name))) matches.set(entry.userId, entry);
  }
  if (matches.size > 1) fail('昵称对应多个 QQ，请明确提供 userId，不能按重名猜测', 409);
  if (!matches.size) fail(allowLegacy ? '找不到要编辑或删除的群友印象' : '当前会话无法确认该昵称的 QQ，请提供已出现的 userId', allowLegacy ? 404 : 400);
  const [userId2, profile] = [...matches][0];
  return { key: `qq:${userId2}`, userId: userId2, displayName: profile.displayName, aliases: profile.aliases || [] };
}

export function appendMemberImpression(st, content, extra = {}) {
  const who = resolveMember(st, extra);
  st.memberImpressions ||= Object.create(null);
  const old = st.memberImpressions[who.key] || {};
  if (own(st.memberImpressions,who.key) && memberQQ(old.userId) !== who.userId) fail('稳定键被未绑定旧记录占用，请先保留并重命名旧记录',409);
  st.memberImpressions[who.key] = { ...old, userId: who.userId, displayName: who.displayName,
    aliases: aliasesOf(old.aliases || [], who.aliases),
    traits: [...new Set([...(old.traits || []), String(content).slice(0,50)])].slice(-20),
    interactionCount: (Number(old.interactionCount) || 0) + 1, lastSeenAt: Date.now() };
  trimMemberImpressions(st);
}

export function trimMemberImpressions(st) {
  const entries = Object.entries(st.memberImpressions || {});
  entries.sort((a,b) => Number(a[1]?.lastSeenAt || 0) - Number(b[1]?.lastSeenAt || 0));
  for (const [key] of entries.slice(0, Math.max(0,entries.length-50))) delete st.memberImpressions[key];
}

export function editMemberImpression(st, target, newContent, extra = {}) {
  const who = resolveMember(st, { target, allowLegacy: true });
  if (!own(st.memberImpressions, who.key)) fail('找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）', 404);
  let next = who;
  if (extra.userId !== undefined) {
    next = resolveMember(st, { userId: extra.userId });
    if (who.userId && who.userId !== next.userId) fail('不能把已绑定记忆改给另一 QQ');
    if (next.key !== who.key && own(st.memberImpressions, next.key)) fail('目标 QQ 已有记忆，不能覆盖',409);
  }
  const entry = { ...st.memberImpressions[who.key] };
  const label = extra.target === undefined ? '' : safeName(extra.target);
  if (label && blocked(label)) fail('非法的群友名字');
  if (newContent !== undefined) entry.traits = String(newContent).split(/[,，、]/).map(x=>x.trim().slice(0,50)).filter(Boolean).slice(0,20);
  if (extra.interactionCount !== undefined) entry.interactionCount = Math.max(0,Number(extra.interactionCount)||0);
  if (next.userId) Object.assign(entry, { userId: next.userId, displayName: label && label !== who.key ? label : next.displayName,
    aliases: aliasesOf(entry.aliases || [], next.aliases, label && label !== who.key ? label : []) });
  else if (label) {
    next = { key: label.startsWith('qq:') ? legacyKey(label,k=>own(st.memberImpressions,k)) : label, legacy: true };
    if (label.startsWith('qq:')) entry.legacyName = label;
    else delete entry.legacyName;
  }
  if (next.key !== who.key && own(st.memberImpressions, next.key)) fail('目标记忆已存在，不能覆盖',409);
  if (next.key !== who.key) delete st.memberImpressions[who.key];
  st.memberImpressions[next.key] = entry;
  trimMemberImpressions(st);
}

export function memberMemoryLabel(key, entry) {
  return memberQQ(entry?.userId) ? `${entry.displayName || `QQ ${entry.userId}`}（QQ ${entry.userId}${entry.aliases?.length ? `；别名：${entry.aliases.join('、')}` : ''}）`
    : `${entry?.legacyName || key}（旧昵称，归属未确认）`;
}
