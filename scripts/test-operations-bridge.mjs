import {test} from 'node:test';import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';

test('最终投递复核费用：自动聊天不消耗模型、不标记已读，直接@仍投递',async()=>{
 const h=await bridgeHarness();h.setMode('reserved2');
 try{
  h.appendSocialV2Message('group:456','群友','来聊天','来聊天',false,false,'42',[],'789');
  h.spendGuard.savePolicy({dailyLimit:0.00001});
  h.tokenLedger.ingestEvent({sessionId:'billing',model:'deepseek-flash',event:{type:'assistant/message',seq:1,time:Date.now(),data:{turn:1,step:1,usage:{inputTokens:1000000}}}});
  const unread=h.getSocialV2State('group:456').unread.length;
  const blocked=await h.deliverPrompt('group:456','测试自动',{wakeReason:'probability'});
  assert.equal(blocked.skipped,true);assert.equal(h.calls.prompts.length,0);assert.equal(h.getSocialV2State('group:456').unread.length,unread);
  assert.equal(h.diagnostics.snapshot().traces[0].status,'blocked');
  const reminder=await h.deliverPrompt('group:456','后台收尾提醒');assert.equal(reminder.skipped,true);assert.equal(h.calls.prompts.length,0);
  const direct=await h.deliverPrompt('group:456','测试直接',{wakeReason:'atMention'});assert.equal(direct.ok,true);assert.equal(h.calls.prompts.length,1);
 }finally{h.diagnostics.flush();await h.close();}
});

test('管理接口拒绝匿名、agent、跨来源；仅精确策略路径接受配置来源POST',async()=>{
 const h=await bridgeHarness({config:{dashboard:{publicOrigin:'https://dashboard.example'}}});
 const st=h.getSocialV2State('group:456');const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`,auth={'x-console-token':'fixture-console-token'};
 const post=(route,headers={},body={dailyLimit:8})=>fetch(base+route,{method:'POST',headers:{...auth,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const anon=await fetch(base+'/dashboard/api/operations');assert.equal(anon.status,401);await anon.arrayBuffer();
  const agent=await fetch(base+'/dashboard/api/operations',{headers:{...auth,'x-agent-token':st.agentToken}});assert.equal(agent.status,403);await agent.arrayBuffer();
  const denied=await post('/dashboard/api/budget-policy',{origin:'https://evil.example'});assert.equal(denied.status,403);await denied.arrayBuffer();
  const good=await post('/dashboard/api/budget-policy',{origin:'https://dashboard.example'});assert.equal(good.status,200);await good.arrayBuffer();
  assert.equal(h.spendGuard.snapshot().policy.dailyLimit,8);
  const wrongRoute=await post('/api/security',{origin:'https://dashboard.example'});assert.equal(wrongRoute.status,403);await wrongRoute.arrayBuffer();
  const bad=await post('/dashboard/api/budget-policy',{origin:'https://dashboard.example'},{dailyLimit:'bad'});assert.equal(bad.status,400);await bad.arrayBuffer();assert.equal(h.spendGuard.snapshot().policy.dailyLimit,8);
  const view=await (await fetch(base+'/dashboard/api/operations',{headers:auth})).json();assert.equal(view.ok,true);assert.ok(!JSON.stringify(view).includes(st.agentToken));
 }finally{await new Promise(r=>server.close(r));h.diagnostics.flush();await h.close();}
});
test('旧社交模式离线恢复保留费用原因，自动消息不绕过预算，直接互动仍保留',async()=>{
 const h=await bridgeHarness();h.setMode('reserved');
 try{
  h.setReady(false);await h.deliverPrompt('group:456','离线自动',{budgetReason:'socialAuto'});
  h.spendGuard.savePolicy({dailyLimit:0});h.setReady(true);await h.flushQueue();assert.equal(h.calls.prompts.length,0);
  h.setReady(false);await h.deliverPrompt('group:456','离线直接',{budgetReason:'atMention'});h.setReady(true);await h.flushQueue();assert.equal(h.calls.prompts.length,1);
 }finally{h.diagnostics.flush();await h.close();}
});
test('旧社交活跃批次保留明确直接互动标记，不把普通闲聊一并豁免',async()=>{
 for(const direct of [true,false]){
  const h=await bridgeHarness({config:{social:{enabled:true,activeReplyDelayMinMs:1,activeReplyDelayMaxMs:1,skipProbability:0}}});h.setMode('reserved');
  try{h.spendGuard.savePolicy({dailyLimit:0});const st=h.socialState('group:456');st.phase='active';st.nextCheckAt=0;st.lastCheckAt=0;st.activeDeadlineAt=Date.now()+3600000;
   h.appendRecentMessage('group:456','群友','你好','你好',direct,false,[],'123',direct);h.socialLoopTick();await new Promise(r=>setTimeout(r,60));assert.equal(h.calls.prompts.length,direct?1:0);
  }finally{h.diagnostics.flush();await h.close();}
 }
});
