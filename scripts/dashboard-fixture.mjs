// 工作台离线演示。数据全部为合成样例；不读取配置、凭据、聊天或连接QQ/DSH。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDashboardApi} from '../src/dashboard.js';
import {createSpendGuard} from '../src/spend-guard.js';
import {createMessageDiagnostics} from '../src/message-diagnostics.js';
import {createOperationsApi} from '../src/operations-routes.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function startDashboardFixture({port=0}={}){
 const now=Date.now();const requests=[];let mode='online';
 const makeState=(names,id)=>({recentMessages:[
  {seq:1,time:now-5*60000,sender:names,userId:id,text:'今天大家有什么计划？',plain:'今天大家有什么计划？'},
  {seq:2,time:now-4*60000,sender:'大肥鱼',isSelf:true,text:'先吃饭，再聊一点有意思的事。'},
  {seq:3,time:now-2*60000,sender:names,userId:id,text:'那就一起听听音乐吧。',media:[{kind:'image',url:'https://not-fetched.invalid/private'}]},
  {seq:4,time:now-60000,sender:'大肥鱼',isSelf:true,text:'好呀，今天的歌单是什么？'},
 ],unread:[],wakeConfig:{mode:'diving'},lastIncomingAt:now-2*60000,lastAiReplyAt:now-60000,lastWakeReason:'atMention',memberDirectory:{[id]:{displayName:names}},
 activeTopics:[{text:'周末一起听歌',pendingQuestion:'想听什么类型？',lastMentionAt:now-60000},{text:'关于今天的晚饭',lastMentionAt:now-3600000}],pendingThoughts:[{text:'下次问问大家最近在听的歌',motivation:'接着刚才的话题聊下去',expiresAt:now+3600000}],
 memberImpressions:{[`qq:${id}`]:{userId:id,displayName:names,traits:['喜欢音乐','经常分享生活'],interactionCount:12}},agentToken:'fixture-never-projected'});
 const conversations=new Map([['group:10001',makeState('示例群友','20001')],['private:20002',makeState('示例朋友','20002')],['group:10003',makeState('示例同学','20003')]]);
 const fakeLedger={summary(){if(mode==='unavailable')throw Error('fixture');return {ok:true,generatedAt:Date.now(),currency:'CNY',symbol:'¥',totals:{totalTokens:8725372,inputTokens:8703365,buckets:{cacheHit:8443648,cacheMiss:259717,cacheWrite:0,output:22007},cost:.459,cacheHitRate:8443648/8703365,turns:35,steps:113},conversations:[...conversations].map(([key],i)=>({key,buckets:{cacheHit:3000000-i*500000,cacheMiss:60000,output:6000},cost:.2-i*.05,turns:12-i,steps:40-i*7}))};},series({hours}){if(mode==='unavailable')throw Error('fixture');const end=Date.now();const buckets=Array.from({length:48},(_,i)=>{const tokens=mode==='empty'?0:Math.round((Math.sin(i*.49)+1.3)*21000+(i%7===0?60000:0));return{t:end-hours*3600000+i*hours*3600000/48,tokens,cacheHit:Math.round(tokens*.96),cacheMiss:Math.round(tokens*.037),output:Math.round(tokens*.003),steps:tokens?2:0};});return{ok:true,hours,from:buckets[0].t,to:end,buckets,totals:{tokens:buckets.reduce((a,b)=>a+b.tokens,0),cost:.25,steps:mode==='empty'?0:96}};}};
 const getSnapshot=()=>({config:{snowluma:{accountId:'99999999'},allow:{groups:['10001','10003'],private:['20002']},dsh:{model:'deepseek-flash',reasoningEffort:'high'},socialV2:{voice:{enabled:true}}},conversations:mode==='empty'?new Map():conversations,displayName:'大肥鱼',mode:'reserved2',paused:false,dshReady:mode!=='offline',upstream:{connected:mode!=='offline',good:mode!=='offline'},recovery:{phase:mode==='offline'?'waiting':'online',message:mode==='offline'?'QQ离线，等待网关自身恢复':'QQ已确认在线，自动恢复服务已就绪',stale:false},now:Date.now(),logTimeZone:'UTC',activity:'[08:15:31] 示例连接检查完成\n[08:16:04] 示例机器人已进入观察状态'});
 fakeLedger.period=({from,to})=>{if(mode==='unavailable')throw Error('fixture');return {available:true,from,to,currency:'CNY',symbol:'¥',cost:mode==='empty'?0:1.24,steps:mode==='empty'?0:35,buckets:{cacheHit:10000,cacheMiss:400,cacheWrite:0,output:100},conversations:mode==='empty'?[]:[...conversations].map(([key],i)=>({key,cost:.8-i*.2,steps:15-i*4})),note:'演示数据：仅用于界面验证，不是实际用量。'};};
 const guard=createSpendGuard({ledger:fakeLedger});let diagnosticTime=now-30000;
 const diagnostics=createMessageDiagnostics({now:()=>diagnosticTime});
 diagnostics.receive('group:10001','101');diagnosticTime+=200;diagnostics.queue('group:10001','atMention');diagnosticTime+=800;diagnostics.dispatch('group:10001');diagnosticTime+=100;diagnostics.model('group:10001');diagnosticTime+=2300;diagnostics.sendStart('group:10001');diagnosticTime+=150;diagnostics.sent('group:10001');diagnostics.end('group:10001',{kind:'completed'});
 diagnostics.service('dsh_rpc',false,'request timeout');diagnosticTime+=500;diagnostics.service('dsh_rpc',true);
 const operations=createOperationsApi({spendGuard:guard,diagnostics});
 let api=createDashboardApi({getSnapshot,ledger:fakeLedger});
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const send=(data,status=200)=>{if(url.pathname==='/dashboard/api/overview'&&data.ok)data.demo=true;res.writeHead(status,{'content-type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
   if(url.pathname==='/__fixture/requests'){send(requests);return;}
   if(url.pathname==='/__fixture/mode'){mode=url.searchParams.get('value')||'online';api=createDashboardApi({getSnapshot,ledger:fakeLedger});send({mode});return;}
   if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
   if(url.pathname==='/'||url.pathname==='/dashboard'){res.writeHead(302,{location:'/dashboard/'});res.end();return;}
   const files={'/dashboard/':'dashboard.html','/dashboard/dashboard.css':'dashboard.css','/dashboard/dashboard.js':'dashboard.js','/dashboard/dashboard-avatar.jpg':'dashboard-avatar.jpg'};
   if(files[url.pathname]){const name=files[url.pathname];res.writeHead(200,{'content-type':name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.jpg')?'image/jpeg':'text/html; charset=utf-8'});res.end(await fs.readFile(path.join(root,'public',name)));return;}
   requests.push({method:req.method,path:url.pathname});
   if(req.headers['x-console-token']!=='fixture-dashboard-token'){send({ok:false},401);return;}
   if(mode==='save-error'&&url.pathname==='/dashboard/api/budget-policy'){send({ok:false,error:'fixture save error'},503);return;}
   if(await operations(req,url,send,async()=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body);} ))return;
   if(await api(req,url,send))return;send({ok:false},404);
  }catch{send({ok:false,error:'fixture error'},500);}
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return {server,url:`http://127.0.0.1:${server.address().port}/dashboard/`,requests,close:()=>new Promise(resolve=>server.close(resolve))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const fixture=await startDashboardFixture({port:Number(process.env.DASHBOARD_FIXTURE_PORT)||4187});console.log(`工作台演示：${fixture.url}（全部为演示数据，不连接QQ）`);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await fixture.close();process.exit(0);});
}
