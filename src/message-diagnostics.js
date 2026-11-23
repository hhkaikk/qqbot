// 有界消息处理元数据；不接收正文、模型输出、URL、凭据或原始错误日志。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const validKey=key=>/^(group|private):[1-9]\d{0,19}$/.test(key);
const independentReasons = new Set(['proactiveCheck', 'replyCheck', 'timeout', 'bootstrap', 'background']);
const labels={tool_json:'模型工具参数格式错误',balance:'模型账户余额不足',timeout:'请求超时',auth:'服务鉴权失败',network:'服务网络不可达',unknown:'处理失败，原因未分类',
  budget_exceeded:'当天主动聊天预算已达上限',conversation_budget_exceeded:'本会话主动聊天预算已达上限',anomaly_cooldown:'自动调用异常，冷却中',usage_unavailable:'费用暂不可核对',configuration_unavailable:'保护配置不可读',offline:'服务尚未就绪'};
export function classifyOperationalError(error) {
  const message = String(error?.message ?? error ?? '');
  const patterns = [
    ['tool_json', /tool input is invalid JSON/i],
    ['balance', /insufficient.?balance|余额不足|欠费/i],
    ['timeout', /timeout|timed out|超时|TimeoutError/i],
    ['auth', /401|403|unauthori|认证|鉴权/i],
    ['network', /ECONN|ENET|EHOST|socket|fetch failed|网络/i],
  ];
  const code = patterns.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unknown';
  return { code, message: labels[code] };
}
const duration=(start,end)=>Number.isFinite(start)&&Number.isFinite(end)&&start>0&&end>=start?end-start:null;
export function createMessageDiagnostics({file,now=Date.now,maxTraces=200}={}) {
  let traces=[],incidents=[],services={},timer;
  const pending=new Map(),active=new Map();
  try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(Array.isArray(saved.traces))traces=saved.traces.filter(x=>validKey(x?.key)).slice(-maxTraces).map(x=>({
      id:/^[a-f0-9-]{36}$/i.test(x.id||'')?x.id:randomUUID(),key:x.key,messageId:/^-?\d{1,20}$/.test(x.messageId||'')?x.messageId:null,
      reason:/^[A-Za-z]+(?::[A-Za-z]+)?$/.test(x.reason||'')?x.reason:null,
      status:['queued','dispatching','model'].includes(x.status)?'interrupted':['received','replied','observed','error','blocked','interrupted'].includes(x.status)?x.status:'interrupted',
      ...Object.fromEntries(['receivedAt','queuedAt','dispatchedAt','modelAt','sendStartedAt','sentAt','endedAt','notificationSentAt'].map(k=>[k,Number.isFinite(x[k])&&x[k]>0?x[k]:null])),
      ...(x.error?{error:{code:labels[x.error.code]?x.error.code:'unknown',message:labels[x.error.code]||labels.unknown}}:{}),
    }));
    if(Array.isArray(saved.incidents))incidents=saved.incidents.filter(x=>['qq','dsh_rpc','dsh_events','bridge'].includes(x.scope)&&typeof x.time==='number').slice(-60).map(x=>({time:x.time,scope:x.scope,code:labels[x.code]?x.code:'unknown',message:x.recovered?'服务连接已恢复':labels[x.code]||labels.unknown,recovered:x.recovered===true}));
  }catch{}
  function flush(){clearTimeout(timer);timer=null;if(!file)return;
    const tmp=`${file}.${process.pid}.tmp`;
    try{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(tmp,JSON.stringify({traces,incidents}),{mode:0o600});fs.renameSync(tmp,file);}catch{}finally{try{fs.unlinkSync(tmp);}catch{}}
  }
  function changed(){if(file&&!timer){timer=setTimeout(flush,500);timer.unref?.();}}
  function add(key,messageId=null){if(!validKey(key))return null;const t={id:randomUUID(),key,messageId:/^-?\d{1,20}$/.test(String(messageId))?String(messageId):null,receivedAt:messageId===null?null:now(),status:'received',reason:null};traces.push(t);
    if(traces.length>maxTraces){const removed=traces.splice(0,traces.length-maxTraces);for(const r of removed){if(pending.get(r.key)===r)pending.delete(r.key);if(active.get(r.key)===r)active.delete(r.key);}}
    changed();return t;
  }
  // 被新来信替换的候选尚未投递模型，保留为已收到，防止重启后误报中断。
  function replacePending(key, trace) {
    const previous = pending.get(key);
    if (previous && previous !== trace && previous.status === 'queued') {
      previous.status = 'received';
      previous.queuedAt = null;
      previous.reason = null;
    }
    pending.set(key, trace);
  }

  function receive(key, messageId) {
    const trace = add(key, messageId);
    if (!trace) return;
    replacePending(key, trace);
    return trace.id;
  }

  function candidate(key, reason) {
    const trace = pending.get(key);
    // 定时主动机会没有对应的一条来信，不能沿用旧消息的接收时间。
    if (independentReasons.has(reason) && trace?.reason !== reason) return add(key);
    return trace || add(key);
  }

  function queue(key, reason) {
    const trace = candidate(key, reason);
    if (!trace) return;
    replacePending(key, trace);
    trace.queuedAt ??= now();
    trace.reason = /^[A-Za-z]+(?::[A-Za-z]+)?$/.test(reason || '') ? reason : null;
    trace.status = 'queued';
    changed();
  }

  function dispatch(key, reason) {
    const trace = candidate(key, reason);
    if (!trace) return;
    replacePending(key, trace);
    pending.delete(key);
    active.set(key, trace);
    trace.reason ??= /^[A-Za-z]+$/.test(reason || '') ? reason : null;
    trace.dispatchedAt = now();
    trace.status = 'dispatching';
    changed();
  }
  function model(key){const t=active.get(key);if(t){t.modelAt??=now();t.status='model';changed();}}
  function sendStart(key){const t=active.get(key);if(t&&!t.sentAt&&!t.error){t.sendStartedAt??=now();changed();}}
  function sent(key){const t=active.get(key);if(t){if(t.error){t.notificationSentAt=now();changed();return;}if(t.endedAt&&t.sentAt)return;t.sentAt??=now();t.status='replied';t.sentCount=(t.sentCount||0)+1;changed();}}
  function fail(key,error){const t=active.get(key)||pending.get(key);if(t){Object.assign(t,{error:classifyOperationalError(error),status:'error',endedAt:now()});changed();}}
  function block(key,reason){const t=pending.get(key)||add(key);if(t){pending.delete(key);t.status='blocked';t.error={code:labels[reason]?reason:'unknown',message:labels[reason]||labels.unknown};t.endedAt=now();changed();}}
  function end(key,reason){const t=active.get(key);if(!t)return;t.endedAt=now();
    if(reason?.kind==='error')fail(key,reason.error);else if(!t.sentAt)t.status=reason?.kind==='completed'?'observed':'interrupted';changed();
  }
  function service(scope,ok,error){if(!['qq','dsh_rpc','dsh_events','bridge'].includes(scope))return;
    const before=services[scope];const detail=ok?null:classifyOperationalError(error);services[scope]={ok:ok===true,checkedAt:now(),error:detail};
    if(before?.ok===ok&&(ok||before?.error?.code===detail.code))return;
    if(ok&&!before)return;
    incidents.push({time:now(),scope,code:detail?.code||'unknown',message:ok?'服务连接已恢复':detail.message,recovered:ok===true});incidents=incidents.slice(-60);changed();
  }
  function snapshot(){return {generatedAt:now(),since:traces[0]?.receivedAt??null,services:structuredClone(services),incidents:structuredClone(incidents).reverse(),
    traces:traces.slice(-maxTraces).reverse().map(t=>({...structuredClone(t),queueMs:duration(t.queuedAt,t.dispatchedAt),dispatchMs:duration(t.dispatchedAt,t.modelAt),
      modelMs:duration(t.modelAt,t.sendStartedAt??t.sentAt),sendMs:duration(t.sendStartedAt,t.sentAt),totalMs:independentReasons.has(t.reason)?null:duration(t.receivedAt,t.sentAt)})),
    note:'从本次更新起记录阶段元数据；未触发回复的来信显示已收到，缺失事件不推算耗时。发送回执表示网关接受，不代表对方已读。'};}
  return {receive,queue,dispatch,model,sendStart,sent,fail,block,end,service,snapshot,flush};
}
