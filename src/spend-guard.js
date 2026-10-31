// 主动聊天费用保护。只处理投递资格，不发QQ、不取消直接互动、不冒充官方余额。
import fs from 'node:fs';import path from 'node:path';
const DIRECT = new Set(['private','atMention','nameMention','admin']);
const validKey = key => /^(?:group|private):[1-9]\d{0,19}$/.test(key) || key==='internal:黑话学习';
const defaults = () => ({dailyLimit:null,conversationLimits:{},anomalyEnabled:true});
const amount = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
export function beijingDayWindow(at=Date.now()) {
  if (!Number.isFinite(at)) throw new Error('时间不可用');
  const day=new Date(at+8*3600000).toISOString().slice(0,10);
  const from=Date.parse(`${day}T00:00:00+08:00`);
  return {day,from,to:from+86400000};
}
function policyOf(input, previous=defaults()) {
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['dailyLimit','conversationLimits','anomalyEnabled'].includes(k))) throw new Error('费用策略字段无效');
  const next={...previous,...input};
  if (!amount(next.dailyLimit) || typeof next.anomalyEnabled!=='boolean') throw new Error('预算应为非负金额或空值，异常保护应为开关');
  const limits=next.conversationLimits;
  if (!limits || typeof limits!=='object' || Array.isArray(limits) || Object.keys(limits).length>100
    || Object.entries(limits).some(([k,v])=>!validKey(k)||!amount(v))) throw new Error('会话预算无效');
  return {...next,conversationLimits:Object.fromEntries(Object.entries(limits))};
}
function write(file,value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;
  try {fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
  finally {try{fs.unlinkSync(tmp);}catch{}}
}
export function createSpendGuard({ledger,policyFile,stateFile,now=Date.now}={}) {
  let broken=false,policy=defaults(),state={wakes:[],cooldowns:{}};
  function read(file) {try{return file?JSON.parse(fs.readFileSync(file,'utf8')):null;}catch(e){if(e.code!=='ENOENT')broken=true;return null;}}
  const savedPolicy=read(policyFile);if(savedPolicy)try{policy=policyOf(savedPolicy);}catch{broken=true;}
  const savedState=read(stateFile);
  if(savedState){
    if(!Array.isArray(savedState.wakes)||!savedState.cooldowns||typeof savedState.cooldowns!=='object')broken=true;
    else state={wakes:savedState.wakes.filter(x=>validKey(x?.key)&&Number.isFinite(x.at)).slice(-2000),
      cooldowns:Object.fromEntries(Object.entries(savedState.cooldowns).filter(([k,v])=>validKey(k)&&Number.isFinite(v)).slice(-100))};
  }
  function usage(from,to){
    try {const x=ledger.period({from,to});
      if(x?.available===false)return {available:false,cost:null,steps:null,conversations:[],buckets:null,currency:x.currency||'CNY',symbol:x.symbol||'¥',note:x.note||'费用暂不可核对'};
      if(x?.available!==true||!Number.isFinite(x.cost)||x.cost<0||!Number.isFinite(x.steps)||!Array.isArray(x.conversations))throw Error();
      return x;
    }catch{return {available:false,cost:null,steps:null,conversations:[],buckets:null,currency:'CNY',symbol:'¥'};}
  }
  function snapshot() {
    const at=now(),day=beijingDayWindow(at),today=usage(day.from,Math.min(day.to,at+1)),window=usage(at-300000,at+1),alerts=[];
    if(broken)alerts.push({code:'configuration_unavailable',level:'error',message:'费用保护配置不可读，自动聊天暂缓，请重新保存策略'});
    if(!today.available)alerts.push({code:'usage_unavailable',level:'warning',message:'当日费用暂不可核对，不显示为零'});
    if(today.available&&policy.dailyLimit!==null&&today.cost>=policy.dailyLimit*.8)alerts.push({code:today.cost>=policy.dailyLimit?'budget_exceeded':'budget_warning',level:today.cost>=policy.dailyLimit?'error':'warning',message:today.cost>=policy.dailyLimit?'当天主动聊天预算已达上限':'当天估算费用已达预算的80%'});
    if(today.available)for(const [key,limit] of Object.entries(policy.conversationLimits)) {
      const cost=today.conversations.find(x=>x.key===key)?.cost??0;
      if(limit!==null&&cost>=limit*.8)alerts.push({key,code:cost>=limit?'conversation_budget_exceeded':'conversation_budget_warning',level:cost>=limit?'error':'warning',message:`${key} ${cost>=limit?'已达会话预算上限':'已达会话预算的80%'}`});
    }
    const cooldowns=Object.entries(state.cooldowns).filter(([,until])=>until>at).map(([key,until])=>({key,until}));
    if(policy.anomalyEnabled&&cooldowns.length)alerts.push({code:'anomaly_cooldown',level:'warning',message:'部分会话自动调用异常，冷却期间保留直接互动'});
    return {policy:structuredClone(policy),day:day.day,timeZone:'Asia/Shanghai',today,window,cooldowns:policy.anomalyEnabled?cooldowns:[],alerts,
      note:'费用来自已记录请求和配置价目表，非官方余额；预算只限制自动聊天，@、名字唤醒、私聊与管理员唤醒保留，已启动请求可能继续计费。',
      limits:{windowMinutes:5,maxBackgroundWakes:12,maxRequests:80,cooldownMinutes:10},configurationAvailable:!broken};
  }
  function allow(key,reason,{commit=true}={}) {
    if(DIRECT.has(String(reason).split(':')[0]))return {allowed:true,direct:true};
    if(broken)return {allowed:false,reason:'configuration_unavailable'};
    const s=snapshot(),at=now(),limit=policy.conversationLimits[key];
    const row=s.today.conversations.find(x=>x.key===key);
    const hasLimit=limit!==undefined&&limit!==null;
    if((policy.dailyLimit!==null||hasLimit)&&!s.today.available)return {allowed:false,reason:'usage_unavailable'};
    if(policy.dailyLimit!==null&&s.today.cost>=policy.dailyLimit)return {allowed:false,reason:'budget_exceeded'};
    if(hasLimit&&(row?.cost??0)>=limit)return {allowed:false,reason:'conversation_budget_exceeded'};
    if(policy.anomalyEnabled){
      const until=state.cooldowns[key];if(until>at)return {allowed:false,reason:'anomaly_cooldown',until};
      const count=state.wakes.filter(x=>x.key===key&&x.at>at-300000&&x.at<=at).length;
      const requests=s.window.conversations.find(x=>x.key===key)?.steps??0;
      if(count>=12||requests>=80){
        const next={...state,cooldowns:{...state.cooldowns,[key]:at+600000}};
        // 预检不消耗唤醒额度，但已观察到的异常必须立即持久化，否则早退会绕过冷却。
        write(stateFile,next);state=next;
        return {allowed:false,reason:'anomaly_cooldown',until:at+600000};
      }
    }
    if(commit){
      const next={wakes:[...state.wakes.filter(x=>x.at>at-300000&&x.at<=at),{key,at}].slice(-2000),cooldowns:Object.fromEntries(Object.entries(state.cooldowns).filter(([,until])=>until>at))};
      write(stateFile,next);state=next;
    }
    return {allowed:true};
  }
  function savePolicy(input){const next=policyOf(input,policy);
    if(broken)write(stateFile,{wakes:[],cooldowns:{}});
    write(policyFile,next);policy=next;
    if(broken){state={wakes:[],cooldowns:{}};broken=false;}
    return structuredClone(policy);
  }
  return {snapshot,allow,savePolicy};
}
