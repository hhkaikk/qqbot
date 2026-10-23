import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { messageFocus, relationRefs } from '../src/message-relations.js';

test('明确引用链归并，穿插的无引用消息不虚构父消息',async()=>{
 const h=await bridgeHarness();
 try{
  const key='group:456';h.setSelfIdentity('大肥鱼','42');
  h.appendSocialV2Message(key,'A','聊下棋','聊下棋',false,false,'101',[],'123');
  h.appendSocialV2Message(key,'B','聊唱歌','聊唱歌',false,false,'102',[],'789');
  h.appendSocialV2Message(key,'C','[引用 A：聊下棋]我也玩','我也玩',false,false,'103',[],'888',[],false,
   {replyTo:{messageId:'101',sender:'A',userId:'123'},mentionedUserIds:['123']});
  h.appendSocialV2Message(key,'A','[引用 C：我也玩]一起','一起',false,false,'104',[],'123',[],false,
   {replyTo:{messageId:'103',sender:'C',userId:'888'}});
  const m=h.getSocialV2State(key).recentMessages;
  assert.equal(m[2].replyTo.userId,'123');assert.equal(m[2].userId,'888');
  assert.equal(m[0].threadId,m[2].threadId);assert.equal(m[2].threadId,m[3].threadId);
  assert.notEqual(m[0].threadId,m[1].threadId);assert.equal(m[1].replyTo,undefined);
 }finally{await h.close();}
});

test('快照焦点优先直接找机器人，不能被另一条引用别人消息挤走',async()=>{
 const h=await bridgeHarness();
 try{
  const key='group:456';h.setSelfIdentity('大肥鱼','42');
  h.appendSocialV2Message(key,'A','@大肥鱼 问你','@大肥鱼 问你',false,false,'101',[],'123',[],true,{mentionedUserIds:['42']});
  h.appendSocialV2Message(key,'B','[引用 C：旧话]那件事','那件事',false,false,'102',[],'789',[],false,
   {replyTo:{messageId:'99',sender:'C',userId:'888'}});
  const packet=h.buildWakeSnapshotV2(key);
  assert.equal(packet.focus.messageId,'101');assert.equal(packet.focus.userId,'123');
  assert.equal(packet.messages[1].replyTo.userId,'888');assert.notEqual(packet.focus.threadId,packet.messages[1].threadId);
 }finally{await h.close();}
});

test('关闭读取或预算截断时，焦点不能透露未提供的最后一条',async()=>{
 const h=await bridgeHarness({config:{socialV2:{context:{wakeMaxChars:650,wakeMessageLimit:12,wakeRecentLimit:0}}}});
 try{
  const key='group:456';
  for(let i=1;i<=8;i++)h.appendSocialV2Message(key,'A','长内容'.repeat(60),'长内容'.repeat(60),false,false,String(i),[],'123');
  const packet=h.buildWakeSnapshotV2(key);
  assert.ok(JSON.stringify(packet).length<=650);
  if(packet.focus)assert.ok(packet.messages.some(m=>m.messageId===packet.focus.messageId));
  h.cfg.socialV2.tools={...h.cfg.socialV2.tools,getUnread:false,getRecent:false};
  assert.equal(h.buildWakeSnapshotV2(key),null);
 }finally{await h.close();}
});

test('只有历史没有新消息时，不把已回答的 @ 再设成焦点',()=>{
 assert.equal(messageFocus([],[{messageId:'1',userId:'123',atSelf:true}]),null);
 assert.deepEqual(relationRefs('[CQ:reply,id=-12][CQ:at,qq=42]你好'),{replyMessageId:'-12',mentionedUserIds:['42']});
});

test('实际收件保留引用作者和 @ 对象，跨群引用不泄露身份',async()=>{
 const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false}}}});
 try{
  h.setMode('reserved2');h.setSelfIdentity('大肥鱼','42');
  h.bot.getMessage=async id=>({group_id:id===101?456:999,user_id:123,sender:{user_id:123,nickname:'A'},message:[{type:'text',data:{text:'下棋'}}]});
  const event=(id,quote)=>({group_id:456,user_id:789,self_id:42,message_id:id,sender:{nickname:'B'},message:[{type:'reply',data:{id:String(quote)}},{type:'at',data:{qq:'42'}},{type:'text',data:{text:'这个呢'}}]});
  await h.handleIncoming('group',456,event(102,101),h.cfg);
  const first=h.getSocialV2State('group:456').recentMessages.at(-1);
  assert.equal(first.userId,'789');assert.equal(first.replyTo.userId,'123');assert.equal(first.replyTo.resolved,true);
  assert.deepEqual(Array.from(first.mentionedUserIds),['42']);
  await h.handleIncoming('group',456,event(103,100),h.cfg);
  const other=h.getSocialV2State('group:456').recentMessages.at(-1);
  assert.equal(other.replyTo.userId,null);assert.equal(other.replyTo.resolved,false);
 }finally{await h.close();}
});
