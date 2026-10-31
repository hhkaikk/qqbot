import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildDashboardOverview,projectDashboardConversation,createDashboardApi} from '../src/dashboard.js';

const now=1793250000000;
const state=()=>({agentToken:'fixture-secret-token',recentMessages:[{seq:1,time:now-1000,userId:'42',sender:'群友',text:'你好',isSelf:false,media:[{kind:'image',url:'https://private.invalid/?token=secret'}]},{seq:2,time:now,sender:'你',text:'我在呀',isSelf:true}],unread:[],activeTopics:[{text:'晚饭',lastMentionAt:now}],pendingThoughts:[{text:'过期想法',expiresAt:now-1},{text:'问候大家',expiresAt:now+10000}],memberImpressions:{'qq:42':{userId:'42',displayName:'群友',traits:['喜欢音乐'],interactionCount:3}},memberDirectory:{42:{displayName:'群友'}},wakeConfig:{mode:'diving'},lastAiReplyAt:now});
test('仅输出界面需要的字段，消息媒体与配置不泄露令牌或URL',()=>{
 const st=state();const d=buildDashboardOverview({config:{snowluma:{accountId:'900000008',accessToken:'fixture-api-key'},dsh:{model:'deepseek-flash',authToken:'fixture-dsh-key'},allow:{groups:['7']}},conversations:new Map([['group:7',st]]),upstream:{connected:true,good:true},dshReady:true,now});
 assert.equal(d.bot.connection,'online');assert.equal(d.conversations[0].recentCount,2);assert.equal(d.counts.memories,3);
 assert.ok(!/fixture-secret-token|fixture-api-key|fixture-dsh-key|private.invalid/.test(JSON.stringify(d)));
 const detail=projectDashboardConversation('group:7',st,{now});assert.equal(detail.messages[0].sender,'群友');assert.deepEqual(detail.messages[0].mediaKinds,['image']);assert.equal(detail.memories.thoughts.length,1);
 assert.ok(!JSON.stringify(detail).includes('agentToken'));assert.ok(!JSON.stringify(detail).includes('https://'));
});
test('缺少健康数据不能伪造在线，空状态与未提供的数字保持未知',()=>{
 const d=buildDashboardOverview({config:{},conversations:new Map(),now});assert.equal(d.bot.connection,'unknown');assert.equal(d.bot.dshReady,null);assert.equal(d.counts.conversations,0);
 assert.deepEqual(d.conversations,[]);assert.equal(d.bot.accountId,null);
});
test('账号已明确离线时，WebSocket和旧good状态不能伪报QQ在线',()=>{
 const d=buildDashboardOverview({upstream:{connected:true,good:true,accountOnline:false},recovery:{phase:'online',stale:false}});assert.equal(d.bot.connection,'offline');
});
test('聊天与记忆只做只读投影，超量有界，HTML按原始文本保留由前端安全显示',()=>{
 const st=state();st.recentMessages=Array.from({length:300},(_,n)=>({seq:n+1,text:'<img src=x onerror=alert(1)>',time:now+n}));const original=JSON.stringify(st);
 const d=projectDashboardConversation('group:7',st,{now});assert.equal(d.messages.length,100);assert.equal(d.messages[0].text,'<img src=x onerror=alert(1)>');assert.equal(d.retainedCount,300);assert.equal(JSON.stringify(st),original);
});
test('查询管理数据不会消费模型、标记已读或写状态，缺失账本明确不可用',async()=>{
 const st=state();const original=JSON.stringify(st);const calls=[];const api=createDashboardApi({getSnapshot:()=>({config:{},conversations:new Map([['group:7',st]]),now}),ledger:{summary(){throw Error('fixture-secret');},series(){throw Error('fixture-secret');}}});
 await api({method:'GET'},new URL('http://local/dashboard/api/overview'),(data,status=200)=>calls.push({data,status}));
 assert.equal(calls[0].data.tokens.available,false);assert.ok(!JSON.stringify(calls).includes('fixture-secret'));assert.equal(JSON.stringify(st),original);
 const bad=[];await api({method:'POST'},new URL('http://local/dashboard/api/overview'),(data,status)=>bad.push(status));assert.deepEqual(bad,[405]);
 const missing=[];await api({method:'GET'},new URL('http://local/dashboard/api/conversation?key=../../config.json'),(data,status)=>missing.push(status));assert.deepEqual(missing,[400]);
});
test('跨会话管理面拒绝智能体调用，拒绝发生在读取数据之前',async()=>{
 let reads=0;const api=createDashboardApi({getSnapshot:()=>{reads++;return{};},ledger:{}});const statuses=[];
 for(const headers of [{'x-agent-call':'1'},{'x-agent-token':'fixture'}])await api({method:'GET',headers},new URL('http://local/dashboard/api/overview'),(data,status)=>statuses.push(status));
 assert.deepEqual(statuses,[403,403]);assert.equal(reads,0);
});
test('活动只有时分秒时不虚构日期，凭据片段脱敏',()=>{
 const d=buildDashboardOverview({config:{},conversations:new Map(),activity:'[12:30:01] api_key=sk-abcdef1234567890 token=secret-value\n无日期日志',logTimeZone:'UTC',now});
 const log=d.systemActivity.find(x=>x.clock);assert.equal(log.time,null);assert.equal(log.clock,'12:30:01');assert.equal(log.timeZone,'UTC');assert.ok(!JSON.stringify(d).includes('secret-value'));assert.ok(!JSON.stringify(d).includes('sk-abcdef1234567890'));
});
