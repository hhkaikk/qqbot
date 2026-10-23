import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { restoreMemberMemory, observeMember, resolveMember, appendMemberImpression, editMemberImpression } from '../src/member-memory.js';

async function fixture(run) {
 const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false},sticker:{enabled:false}}}});
 h.setMode('reserved2');const key='group:456',st=h.getSocialV2State(key),server=h.startConsoleServer();
 if(!server.listening)await new Promise(r=>server.once('listening',r));
 const request=(route,body)=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/socialV2/'+route+(route.includes('?')?'&':'?')+'key='+key,method:body?'POST':'GET',headers:{'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-token':st.agentToken}},res=>{
   let raw='';res.on('data',s=>raw+=s);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));
  });req.on('error',reject);req.end(body?JSON.stringify({key,...body}):undefined);
 });
 const observe=(id,name)=>h.appendSocialV2Message(key,name,'来啦','来啦',false,false,String(st.lastUnreadSeq+1),[],id);
 try{await run({h,key,st,request,observe});}finally{await new Promise(r=>server.close(r));await h.close();}
}

test('同名不同 QQ 的印象独立保存，同号改名仍是一条',()=>fixture(async({st,request,observe})=>{
 observe('123','小明');observe('789','小明');
 for(const [userId,content]of[['123','爱下棋'],['789','爱唱歌']]){
  const r=await request('memory-append',{category:'memberImpression',content,extra:{target:'小明',userId}});assert.equal(r.status,200);
 }
 assert.equal(st.memberImpressions['qq:123'].traits[0],'爱下棋');
 assert.equal(st.memberImpressions['qq:789'].traits[0],'爱唱歌');
 observe('123','新名片');
 await request('memory-append',{category:'memberImpression',content:'爱接梗',extra:{userId:'123'}});
 assert.equal(Object.keys(st.memberImpressions).length,2);
 assert.equal(st.memberImpressions['qq:123'].displayName,'新名片');
 assert.ok(st.memberImpressions['qq:123'].aliases.includes('小明'));
}));

test('仅昵称兼容需唯一，重名或未知 QQ 不能静默写错人',()=>fixture(async({st,request,observe})=>{
 observe('123','小明');
 assert.equal((await request('memory-append',{category:'memberImpression',content:'友善',extra:{target:'小明'}})).status,200);
 observe('789','小明');
 assert.equal((await request('memory-append',{category:'memberImpression',content:'不能错绑',extra:{target:'小明'}})).status,409);
 assert.equal((await request('memory-append',{category:'memberImpression',content:'未知',extra:{userId:'999'}})).status,400);
 assert.equal(Object.keys(st.memberImpressions).length,1);
}));

test('按 QQ 编辑删除不影响同名者，旧未绑定记忆仍可查看和编辑',()=>fixture(async({st,request,observe})=>{
 observe('123','小明');observe('789','小明');
 for(const userId of ['123','789'])await request('memory-append',{category:'memberImpression',content:'旧印象',extra:{userId}});
 let r=await request('memory-update',{category:'memberImpression',target:'qq:123',newContent:'新印象'});assert.equal(r.status,200);
 assert.equal(st.memberImpressions['qq:789'].traits[0],'旧印象');
 r=await request('memory-remove',{category:'memberImpression',userId:'123'});assert.equal(r.status,200);
 assert.equal(st.memberImpressions['qq:123'],undefined);assert.ok(st.memberImpressions['qq:789']);
 st.memberImpressions['旧昵称']={traits:['保留我'],interactionCount:1,lastSeenAt:1};
 r=await request('memory?category=memberImpression');assert.match(r.body.formatted,/归属未确认/);
 assert.equal((await request('memory-update',{category:'memberImpression',target:'旧昵称',newContent:'保留并编辑'})).status,200);
 assert.ok(st.memberImpressions['旧昵称']);
}));

test('记忆不能借用另一会话的人名或 QQ 证据',()=>fixture(async({h,request})=>{
 h.appendSocialV2Message('group:999','隔壁成员','消息','消息',false,false,'9',[],'998');
 const r=await request('memory-append',{category:'memberImpression',content:'不能跨群',extra:{userId:'998'}});
 assert.equal(r.status,400);
}));

test('重启保留稳定键和别名；私聊明确 QQ 的旧记忆迁移，不猜群旧昵称',()=>{
 const st={recentMessages:[],memberImpressions:{'私聊 789':{traits:['原有事实'],interactionCount:2,lastSeenAt:1}}};
 restoreMemberMemory(st,'private:789');assert.equal(st.memberImpressions['qq:789'].traits[0],'原有事实');
 observeMember(st,'789','新昵称',2);
 const again=JSON.parse(JSON.stringify(st));restoreMemberMemory(again,'private:789');
 assert.equal(Object.keys(again.memberImpressions).length,1);
 assert.equal(again.memberImpressions['qq:789'].interactionCount,2);
 assert.ok(again.memberImpressions['qq:789'].aliases.includes('新昵称'));
 const group={recentMessages:[{userId:'123',sender:'小明'}],memberImpressions:{小明:{traits:['不许猜绑']}}};
 restoreMemberMemory(group,'group:456');assert.ok(group.memberImpressions['小明']);assert.equal(group.memberImpressions['qq:123'],undefined);
});

test('数字旧昵称编辑删除优先原键，显式 userId 仍定位稳定身份',()=>fixture(async({st,request,observe})=>{
 st.memberImpressions['123']={traits:['数字旧名']};
 assert.equal((await request('memory-update',{category:'memberImpression',target:'123',newContent:'仍是旧名'})).status,200);
 observe('123','另一个人');
 appendMemberImpression(st,'稳定事实',{userId:'123'});
 assert.equal((await request('memory-update',{category:'memberImpression',target:'123',newContent:'改旧名'})).status,200);
 assert.deepEqual(st.memberImpressions['qq:123'].traits,['稳定事实']);
 assert.equal((await request('memory-remove',{category:'memberImpression',target:'123'})).status,200);
 assert.ok(st.memberImpressions['qq:123']);
 assert.equal(resolveMember(st,{userId:'123',allowLegacy:true}).key,'qq:123');
}));

test('qq: 同形旧昵称不能确认身份或覆盖稳定记忆，重命名后重启仍未绑定',()=>{
 const st={recentMessages:[],memberImpressions:{'qq:123':{traits:['未知旧昵称']},old:{traits:['改名旧记录']}}};
 restoreMemberMemory(st,'group:456');
 const legacy=Object.keys(st.memberImpressions).find(k=>st.memberImpressions[k].traits.includes('未知旧昵称'));
 assert.equal(st.memberImpressions[legacy].userId,undefined);
 assert.throws(()=>resolveMember(st,{userId:'123'}));
 observeMember(st,'123','新成员',2);appendMemberImpression(st,'已确认事实',{userId:'123'});
 assert.deepEqual(st.memberImpressions['qq:123'].traits,['已确认事实']);
 assert.deepEqual(st.memberImpressions[legacy].traits,['未知旧昵称']);
 editMemberImpression(st,'old',undefined,{target:'qq:999'});
 restoreMemberMemory(st,'group:456');
 assert.equal(Object.values(st.memberImpressions).find(e=>e.traits.includes('改名旧记录')).userId,undefined);
 assert.throws(()=>resolveMember(st,{userId:'999'}));
});

test('加载超过目录上限及重复重启不丢记忆或抛异常',()=>{
 const st={memberDirectory:Object.fromEntries(Array.from({length:205},(_,i)=>[String(i+1),{displayName:'成员'+i,aliases:['旧名'+i],lastSeenAt:205-i}])),memberImpressions:{'qq:1':{userId:'1',traits:['保留'],interactionCount:3}},recentMessages:[]};
 restoreMemberMemory(st,'group:456');assert.equal(Object.keys(st.memberDirectory).length,200);
 const again=JSON.parse(JSON.stringify(st));restoreMemberMemory(again,'group:456');
 assert.deepEqual(again.memberImpressions,st.memberImpressions);
});

test('桥接真实加载、落盘、再加载保留迁移结果与引用关系',async()=>{
 const first=await bridgeHarness({files:{'state/social-v2.json':{paused:true,conversations:{'private:789':{memberImpressions:{'私聊 789':{traits:['已有事实'],interactionCount:2}},recentMessages:[],unread:[]}}}}});
 let saved;
 try {
  const st=first.getSocialV2State('private:789');assert.deepEqual(st.memberImpressions['qq:789'].traits,['已有事实']);
  first.appendSocialV2Message('private:789','新名片','消息','消息',false,false,'101',[],'789',[],false,{replyTo:{messageId:'100',userId:'789',resolved:true}});
  saved=JSON.parse(fs.readFileSync(path.join(first.temp,'state/social-v2.json'),'utf8'));
 }finally{await first.close();}
 const second=await bridgeHarness({files:{'state/social-v2.json':saved}});
 try {
  const st=second.getSocialV2State('private:789');
  assert.deepEqual(st.memberImpressions['qq:789'].traits,['已有事实']);
  assert.equal(st.memberImpressions['qq:789'].displayName,'新名片');
  assert.equal(st.memberImpressions['qq:789'].interactionCount,2);
  assert.equal(st.recentMessages.at(-1).replyTo.userId,'789');
  assert.equal(st.recentMessages.at(-1).threadId,'msg:100');
 }finally{await second.close();}
});
