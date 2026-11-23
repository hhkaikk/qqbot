import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeHarness} from './audit-bridge-harness.mjs';

for (const reset of [false,true]) test(`补投准备期间${reset?'会话重置':'再次断线'}，新来信不能排到尚未投递的旧消息前面`,async()=>{
 const h=await bridgeHarness();let release;
 try{
  h.setMode('chat');h.api.eventStreamReady=false;
  await h.deliverPrompt('private:123','旧消息甲');
  await h.deliverPrompt('private:123','旧消息乙');
  const create=h.api.sessions.create;let signalStarted;
  const started=new Promise(resolve=>signalStarted=resolve);
  h.api.sessions.create=async(...args)=>{
   signalStarted();await new Promise(resolve=>release=resolve);return create(...args);
  };
  h.api.eventStreamReady=true;h.setReady(true);
  const flushing=h.flushQueue();await started;
  h.api.eventStreamReady=false;
  await h.handleIncoming('private',123,{user_id:123,message:[{type:'text',data:{text:'新消息丙'}}]},h.cfg);
  if (reset) { h.resetEpoch();h.api.eventStreamReady=true; }
  release();await flushing;
  assert.equal(h.calls.prompts.length,0);
  h.api.sessions.create=create;h.api.eventStreamReady=true;
  await h.checkDsh();await h.checkDsh();
  assert.equal(h.calls.prompts.length,3);
  for(const [i,text] of ['旧消息甲','旧消息乙','新消息丙'].entries()){
   assert.ok(JSON.stringify(h.calls.prompts[i].content).includes(text),`第 ${i+1} 条必须是 ${text}`);
  }
 }finally{release?.();await h.close();}
});

test('断线期间同一会话多次唤醒恢复后只读取一次最新快照，保留直接呼叫资格',async()=>{
 const h=await bridgeHarness();
 try{
  h.setMode('reserved2');h.api.eventStreamReady=false;
  h.appendSocialV2Message('group:456','群友','第一条','第一条',false,false,'41',[],'789');
  await h.deliverPrompt('group:456','旧提示',{wakeReason:'atMention'});
  h.appendSocialV2Message('group:456','群友','后续补充','后续补充',false,false,'42',[],'789');
  await h.deliverPrompt('group:456','重复提示',{wakeReason:'question'});
  h.spendGuard.savePolicy({dailyLimit:0});
  h.api.eventStreamReady=true;await h.checkDsh();await h.checkDsh();
  assert.equal(h.calls.prompts.length,1);
  const content=JSON.stringify(h.calls.prompts[0].content);
  assert.ok(content.includes('第一条'));assert.ok(content.includes('后续补充'));
 }finally{await h.close();}
});

test('断线重复唤醒不重复请求模型，普通消息仍按顺序分别补投',async()=>{
 const h=await bridgeHarness();
 try{
  h.setMode('reserved2');h.api.eventStreamReady=false;
  for(let i=0;i<4;i++)await h.deliverPrompt('group:456','重复唤醒',{wakeReason:'atMention'});
  h.api.eventStreamReady=true;await h.checkDsh();
  assert.equal(h.calls.prompts.length,1);
  h.setMode('chat');h.api.eventStreamReady=false;
  for(const text of ['普通消息甲','普通消息乙'])await h.deliverPrompt('group:456',text);
  h.api.eventStreamReady=true;await h.checkDsh();
  assert.equal(h.calls.prompts.length,3);
  assert.ok(JSON.stringify(h.calls.prompts[1].content).includes('普通消息甲'));
  assert.ok(JSON.stringify(h.calls.prompts[2].content).includes('普通消息乙'));
 }finally{await h.close();}
});

test('事件未就绪时 RPC 正常也不能投递模型；恢复后补投且只投一次',async()=>{
 const h=await bridgeHarness();
 try{
  h.api.eventStreamReady=false;
  await h.checkDsh();assert.equal(h.getReady(),false);
  await h.deliverPrompt('group:456','暂存消息');
  assert.equal(h.calls.prompts.length,0);
  h.api.eventStreamReady=true;await h.checkDsh();
  assert.equal(h.getReady(),true);assert.equal(h.calls.prompts.length,1);
  await h.checkDsh();assert.equal(h.calls.prompts.length,1);
 }finally{await h.close();}
});

test('慢健康检查只能有一个在途探测',async()=>{
 const h=await bridgeHarness();let release;
 try{
  let calls=0;const original=h.api.settings.describe;
  h.api.settings.describe=async()=>{calls++;if(calls===1)await new Promise(r=>release=r);return original();};
  const first=h.checkDsh(),second=h.checkDsh();
  const observed=calls;release();await Promise.all([first,second]);assert.equal(observed,1);
 }finally{release?.();await h.close();}
});

test('健康缓存尚未刷新时断线，也必须暂存消息并在恢复后只补投一次',async()=>{
 const h=await bridgeHarness();
 try{
  h.api.eventStreamReady=true;await h.checkDsh();
  h.api.eventStreamReady=false;
  const result=await h.deliverPrompt('group:456','断线窗口消息');
  assert.equal(result.queued,true);assert.equal(h.calls.prompts.length,0);
  h.api.eventStreamReady=true;await h.checkDsh();await h.checkDsh();
  assert.equal(h.calls.prompts.length,1);
 }finally{await h.close();}
});

test('会话准备期间断线，准备完成后不能继续投递',async()=>{
 const h=await bridgeHarness();
 try{
  h.api.eventStreamReady=true;await h.checkDsh();
  const original=h.api.sessions.create;
  h.api.sessions.create=async(...args)=>{const result=await original(...args);h.api.eventStreamReady=false;return result;};
  const result=await h.deliverPrompt('group:456','准备期间消息');
  assert.equal(result.queued,true);assert.equal(h.calls.prompts.length,0);
  h.api.eventStreamReady=true;await h.checkDsh();assert.equal(h.calls.prompts.length,1);
 }finally{await h.close();}
});

test('RPC 返回业务错误不能标记为就绪',async()=>{
 const h=await bridgeHarness();
 try{h.api.settings.describe=async()=>({result:{ok:false,error:{code:'fixture/unavailable',message:'unavailable'}}});await h.checkDsh();assert.equal(h.getReady(),false);}
 finally{await h.close();}
});

test('探测期间事件通道断开，迟到的 RPC 成功不能回写就绪',async()=>{
 const h=await bridgeHarness();let release;
 try{
  h.api.eventStreamReady=true;const original=h.api.settings.describe;let calls=0;
  h.api.settings.describe=async()=>{if(++calls===1)await new Promise(r=>release=r);return original();};
  const check=h.checkDsh();h.api.eventStreamReady=false;release();await check;assert.equal(h.getReady(),false);
 }finally{release?.();await h.close();}
});

for(const duringCreate of [false,true])test(`普通聊天${duringCreate?'准备期间':'健康缓存未刷新时'}断线也暂存并只补投一次`,async()=>{
 const h=await bridgeHarness();
 try{
  h.api.eventStreamReady=true;await h.checkDsh();h.setMode('chat');
  if(duringCreate){
   const original=h.api.sessions.create;
   h.api.sessions.create=async(...args)=>{const result=await original(...args);h.api.eventStreamReady=false;return result;};
  }else h.api.eventStreamReady=false;
  await h.handleIncoming('private',123,{user_id:123,message:[{type:'text',data:{text:'普通聊天断线测试'}}]},h.cfg);
  assert.equal(h.calls.prompts.length,0);
  h.api.eventStreamReady=true;await h.checkDsh();await h.checkDsh();assert.equal(h.calls.prompts.length,1);
 }finally{await h.close();}
});
