import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeHarness} from './audit-bridge-harness.mjs';

async function fixture(run){const h=await bridgeHarness({config:{socialV2:{wake:{directOnly:true},proactive:{enabled:false}}}});h.setMode('reserved2');h.setSelfIdentity('大肥鱼','999');try{await run(h);}finally{await h.close();}}
const message=(extra={})=>({user_id:123,self_id:999,message:[{type:'text',data:{text:'闲聊'}}],...extra});
test('新账号昵称不同，仍能按已配置的角色名叫醒机器人',async()=>{
 const h=await bridgeHarness({config:{socialV2:{wake:{directOnly:true}}},files:{'state/current-role.json':{role:'大肥鱼',mode:'active'}}});h.setMode('reserved2');h.setSelfIdentity('@\u2063\u2063','999');
 try{const st=h.getSocialV2State('group:456');assert.equal(h.evaluateWakeTriggerV2('group:456',st,message(),'group','大肥鱼你好','大肥鱼你好',false),'nameMention');}
 finally{await h.close();}
});
test('保守模式覆盖旧配置的任意消息、概率与跟随触发，保留真正 @/叫名/引用和私聊',()=>fixture(async h=>{
 const st=h.getSocialV2State('group:456');st.wakeConfig.triggers={anyMessage:true,probability:1,question:true,nameMention:false,atMention:false};
 assert.equal(h.evaluateWakeTriggerV2('group:456',st,message(),'group','闲聊','闲聊',false),null);
 assert.equal(h.evaluateWakeTriggerV2('group:456',st,message({message:[{type:'at',data:{qq:'999'}}]}),'group','@大肥鱼','',false),'atMention');
 assert.equal(h.evaluateWakeTriggerV2('group:456',st,message(),'group','大肥鱼你好','大肥鱼你好',false),'nameMention');
 assert.equal(h.evaluateWakeTriggerV2('group:456',st,message(),'group','引用','你好',true),'atMention');
 assert.equal(h.evaluateWakeTriggerV2('private:123',st,message(),'private','你好','你好',false),'private');
}));
test('定时器和暂存主动任务不能再投递模型，管理员和真实互动仍可用',()=>fixture(async h=>{
 const st=h.getSocialV2State('group:456');st.lastIncomingAt=Date.now();
 for(const reason of ['proactiveCheck','replyCheck','timeout','followup','probability','poke'])await h.sendWakePromptV2('group:456',reason);
 assert.equal(h.calls.prompts.length,0);
 await h.sendWakePromptV2('group:456','atMention');assert.equal(h.calls.prompts.length,1);
}));
test('新群首次普通消息不因 bootstrap 自动唤醒',()=>fixture(async h=>{
 await h.handleIncoming('group',456,message(),h.cfg);
 assert.equal(h.getSocialV2State('group:456').bootstrapSent,false);
 assert.equal(!!h.getSocialV2State('group:456').pendingWakeTimer,false);
}));
test('换机器人账号撤销旧会话和令牌，但保留成员记忆；错误账号不能发送',()=>fixture(async h=>{
 const key='group:456',st=h.getSocialV2State(key);st.memberImpressions=[{content:'保留的记忆'}];
 h.cfg.snowluma.accountId='999';const old=await h.ensureSession(key),token=st.agentToken;
 h.cfg.snowluma.accountId='888';const next=await h.ensureSession(key);
 assert.notEqual(next,old);assert.notEqual(st.agentToken,token);assert.equal(st.memberImpressions[0].content,'保留的记忆');
 await h.sendToQQ(key,'测试');assert.equal(h.calls.sent.length,0);
 h.setSelfIdentity('大肥鱼','888');await h.sendToQQ(key,'正确账号测试');assert.equal(h.calls.sent.length,1);
}));
