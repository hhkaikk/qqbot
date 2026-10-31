// 只读管理工作台。仅投影允许字段，不暴露配置、会话令牌、媒体地址或执行工具。
const rows = value => Array.isArray(value) ? value : [];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const time = value => number(value) > 0 ? value : null;
const entries = value => value && typeof value.entries === 'function' ? [...value.entries()] : Object.entries(value || {});
const validKey = key => /^(group|private):[1-9]\d{0,19}$/.test(key);
export function dashboardText(value, max = 1000, redact = x => x) {
  return String(redact(String(value ?? '')))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏密钥]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|密码)["']?\s*[:=：]\s*["']?)[^\s&"'<>，。]+/gi, '$1[已隐藏]')
    .replace(/([?&](?:key|token|auth|sig)=)[^\s&<>]+/gi, '$1[已隐藏]')
    .slice(0, max);
}
const text = (value, max, options) => dashboardText(value, max, options?.redact);

function memories(st, options) {
  const now = options.now ?? Date.now();
  return {
    topics: rows(st.activeTopics).slice(-50).filter(x => x?.text).map(x => ({text:text(x.text,1500,options),pendingQuestion:typeof x.pendingQuestion === 'string' ? text(x.pendingQuestion,500,options) : '',lastMentionAt:time(x.lastMentionAt)})),
    thoughts: rows(st.pendingThoughts).filter(x => x?.text && (!x.expiresAt || x.expiresAt > now)).slice(-50).map(x => ({text:text(x.text,1500,options),motivation:text(x.motivation,500,options),expiresAt:time(x.expiresAt)})),
    people: Object.entries(st.memberImpressions || {}).filter(([k,v]) => !['__proto__','prototype','constructor'].includes(k) && v && typeof v === 'object').slice(-100).map(([key,v]) => ({
      id:/^[1-9]\d{0,19}$/.test(String(v.userId ?? '')) ? String(v.userId) : null,
      name:text(v.displayName || key,80,options),traits:rows(v.traits).slice(-20).map(x => text(x,150,options)),interactionCount:number(v.interactionCount),
    })),
  };
}
function messageView(m, options) {
  return {
    seq:number(m.seq),messageId:m.messageId == null ? null : text(m.messageId,64,options),time:time(m.time),
    sender:m.isSelf === true ? '大肥鱼' : text(m.sender || m.userId || '未知发言者',80,options),
    userId:m.userId == null ? null : text(m.userId,32,options),isSelf:m.isSelf === true,
    text:text(m.plain || m.text,2400,options),previewOnly:true,
    tail:m.tail && m.tail !== m.plain && m.tail !== m.text ? text(m.tail,300,options) : null,
    mediaKinds:[...new Set(rows(m.media).slice(0,20).map(x => ['image','record','face','video','file','forward'].includes(x?.kind) ? x.kind : 'attachment'))],
    replyTo:m.replyTo && typeof m.replyTo === 'object' ? {sender:text(m.replyTo.sender || m.replyTo.userId,80,options),text:text(m.replyTo.text || m.replyTo.preview,250,options)} : null,
  };
}
export function projectDashboardConversation(key, st, options = {}) {
  return {
    key,messages:rows(st.recentMessages).slice(-100).map(m => messageView(m,options)),
    retainedCount:rows(st.recentMessages).length,memories:memories(st,options),
    note:'仅显示桥接保留的最近消息预览；长消息可能截断，不是QQ完整聊天归档。',
  };
}
export function buildDashboardOverview({config = {},conversations,upstream,recovery,dshReady,paused = false,mode,displayName,activity = '',logTimeZone,now = Date.now(),redact,isBusy = () => false} = {}) {
  const options = {now,redact};const details = [];const recent = [];
  for (const [key,st] of entries(conversations)) {
    if (!validKey(key) || !st) continue;
    const view = projectDashboardConversation(key,st,options);
    const [type,id] = key.split(':');const last = view.messages.at(-1);
    const name = type === 'private' ? st.memberDirectory?.[id]?.displayName : null;
    const label = name && name !== '私聊' && name !== id ? `${name} · ${id}` : null;
    details.push({key,type,id,label:text(label || `${type === 'group' ? '群聊' : '私聊'} ${id}`,100,options),
      enabled:rows(config.allow?.[type === 'group' ? 'groups' : 'private']).map(String).includes(id),
      busy:isBusy(key,st) === true,mode:['active','diving'].includes(st.wakeConfig?.mode) ? st.wakeConfig.mode : 'unknown',
      unreadCount:rows(st.unread).length,recentCount:rows(st.recentMessages).length,
      memoryCount:view.memories.topics.length+view.memories.thoughts.length+view.memories.people.length,
      lastIncomingAt:time(st.lastIncomingAt),lastAiReplyAt:time(st.lastAiReplyAt),lastActivityAt:Math.max(last?.time || 0,st.lastIncomingAt || 0,st.lastAiReplyAt || 0) || null,
      lastWakeReason:text(st.lastWakeReason,60,options),preview:last?.text || '',
    });
    recent.push(...view.messages.slice(-8).map(m => ({...m,key})));
  }
  details.sort((a,b) => (b.lastActivityAt || 0)-(a.lastActivityAt || 0));
  const messageEvents = recent.filter(m => m.time).map(m => ({type:m.isSelf ? 'reply' : 'message',key:m.key,time:m.time,text:`${m.sender}：${m.text}`}));
  // 原日志仅有时分秒，没有可靠日期。明确保留原始时钟与时区，不推算日期。
  const logs = String(activity).split('\n').filter(Boolean).slice(-50).reverse().map(line => {
    const match = /^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/.exec(line);
    return {type:'system',key:null,time:null,clock:match?.[1] || null,timeZone:logTimeZone || null,text:text(match?.[2] || line,1200,options)};
  });
  let connection = 'unknown';
  if (upstream?.accountOnline === false || upstream?.connected === false) connection = 'offline';
  else if (upstream?.connected === true) {
    if (upstream.degraded === true || upstream.good === false) connection = 'degraded';
    else if (upstream.good === true || recovery?.phase === 'online' && !recovery.stale) connection = 'online';
  }
  return {ok:true,generatedAt:now,timeZone:'Asia/Shanghai',
    bot:{name:text(displayName || '大肥鱼',80,options),accountId:config.snowluma?.accountId ? text(config.snowluma.accountId,32,options) : null,
      connection,dshReady:typeof dshReady === 'boolean' ? dshReady : null,paused:paused === true,mode:text(mode,40,options),
      model:text(config.dsh?.model,80,options) || null,reasoningEffort:text(config.dsh?.reasoningEffort,24,options) || null,
      voiceEnabled:config.socialV2?.voice?.enabled === true,
      recovery:recovery ? {phase:text(recovery.phase,40,options),message:text(recovery.message,300,options),stale:recovery.stale === true,requiresAction:recovery.requiresAction === true} : null},
    counts:{conversations:details.length,busy:details.filter(x => x.busy).length,retainedMessages:details.reduce((a,x) => a+x.recentCount,0),memories:details.reduce((a,x) => a+x.memoryCount,0)},
    conversations:details,recentMessages:recent.sort((a,b) => (b.time || 0)-(a.time || 0)).slice(0,12),
    activity:messageEvents.sort((a,b) => b.time-a.time).slice(0,50),systemActivity:logs,
  };
}

function usageSummary(data) {
  const t = data?.totals;
  if (!data?.ok || number(t?.totalTokens) === null) return {available:false};
  return {available:true,generatedAt:time(data.generatedAt),totalTokens:t.totalTokens,inputTokens:number(t.inputTokens),
    outputTokens:number(t.buckets?.output),cacheHitTokens:number(t.buckets?.cacheHit),cacheMissTokens:number(t.buckets?.cacheMiss),
    cacheHitRate:number(t.cacheHitRate),estimatedCost:number(t.cost),currency:dashboardText(data.currency,8),symbol:dashboardText(data.symbol,4),
    turns:number(t.turns),requests:number(t.steps),
    conversations:rows(data.conversations).slice(0,100).map(x => ({key:dashboardText(x.key,50),tokens:number(x.buckets?.cacheHit) === null ? null : (x.buckets.cacheHit+(x.buckets.cacheMiss || 0)+(x.buckets.cacheWrite || 0)+(x.buckets.output || 0)),cost:number(x.cost),turns:number(x.turns),requests:number(x.steps)})),
  };
}
function usageSeries(data) {
  if (data?.ok === false || !Array.isArray(data?.buckets)) return {available:false};
  return {available:true,generatedAt:time(data.generatedAt || data.to),hours:number(data.hours),from:time(data.from),to:time(data.to),
    totalTokens:number(data.totals?.tokens),estimatedCost:number(data.totals?.cost),requests:number(data.totals?.steps),
    buckets:data.buckets.slice(-120).map(x => ({t:time(x.t),tokens:number(x.tokens),cacheHit:number(x.cacheHit),cacheMiss:number(x.cacheMiss),output:number(x.output),requests:number(x.steps)}))};
}
export function createDashboardApi({getSnapshot,ledger,now = () => Date.now()}) {
  const cache = new Map();
  async function cached(key,read,project) {
    const existing = cache.get(key);
    if (existing && now()-existing.at < 30000) return existing.data;
    try {const data=project(await read());cache.set(key,{at:now(),data});return data;}
    catch {const data=existing?.data?.available ? {...existing.data,stale:true} : {available:false};cache.set(key,{at:now(),data});return data;}
  }
  return async function handle(req,url,sendJson) {
    if (!url.pathname.startsWith('/dashboard/api/')) return false;
    if (req.headers?.['x-agent-call'] !== undefined || req.headers?.['x-agent-token'] !== undefined) {sendJson({ok:false,error:'工作台仅供管理员访问'},403);return true;}
    if (req.method !== 'GET') {sendJson({ok:false,error:'工作台是只读接口'},405);return true;}
    if (url.pathname === '/dashboard/api/usage') {
      const hours = Number(url.searchParams.get('hours') || 24);
      if (![24,168].includes(hours)) {sendJson({ok:false,error:'仅支持24小时或7天窗口'},400);return true;}
      sendJson(await cached(`series:${hours}`,() => ledger.series({hours,maxBuckets:48}),usageSeries));return true;
    }
    if (url.pathname === '/dashboard/api/overview') {
      const overview = buildDashboardOverview(getSnapshot());
      overview.tokens = await cached('summary',() => ledger.summary({limit:100}),usageSummary);sendJson(overview);return true;
    }
    if (url.pathname === '/dashboard/api/conversation') {
      const key = url.searchParams.get('key') || '';
      if (!validKey(key)) {sendJson({ok:false,error:'无效会话'},400);return true;}
      const snapshot=getSnapshot();const st=entries(snapshot.conversations).find(([k]) => k === key)?.[1];
      if (!st) {sendJson({ok:false,error:'此会话暂无保留记录'},404);return true;}
      sendJson({ok:true,generatedAt:snapshot.now || now(),...projectDashboardConversation(key,st,snapshot)});return true;
    }
    sendJson({ok:false,error:'未找到工作台接口'},404);return true;
  };
}
