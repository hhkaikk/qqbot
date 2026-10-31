import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeHarness} from './audit-bridge-harness.mjs';

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
