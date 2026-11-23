import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMessageDiagnostics,classifyOperationalError} from '../src/message-diagnostics.js';
test('新消息不会覆盖活跃轮次；阶段时长只来自实际事件，读状态不写盘',()=>{
 let at=1000;const d=createMessageDiagnostics({now:()=>at});
 d.receive('group:1','11');at=1100;d.queue('group:1','atMention');at=1300;d.dispatch('group:1');at=1500;d.model('group:1');
 at=1600;d.receive('group:1','12');at=1800;d.sendStart('group:1');at=1900;d.sent('group:1');at=2000;d.end('group:1',{kind:'completed'});
 const s=d.snapshot();const first=s.traces.find(x=>x.messageId==='11'),second=s.traces.find(x=>x.messageId==='12');
 assert.equal(first.status,'replied');assert.equal(first.totalMs,900);assert.equal(first.queueMs,200);assert.equal(first.sendMs,100);assert.equal(first.modelMs,300);
 assert.equal(second.status,'received');assert.equal(second.totalMs,null);
});
test('错误只保存固定分类，不落盘原始密钥或聊天；重启保留有界轨迹和中断状态',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-diag-'));const file=path.join(dir,'diag.json');let at=1000;
 try{const d=createMessageDiagnostics({file,now:()=>at});d.receive('private:1','1');d.dispatch('private:1');
 d.service('dsh_rpc',false,new Error('Insufficient Balance sk-private-secret'));d.flush();
 const raw=fs.readFileSync(file,'utf8');assert.ok(!raw.includes('sk-private'));const reopened=createMessageDiagnostics({file,now:()=>++at});
 assert.equal(reopened.snapshot().traces[0].status,'interrupted');assert.equal(reopened.snapshot().incidents[0].code,'balance');
 const before=fs.readFileSync(file,'utf8');reopened.snapshot();assert.equal(fs.readFileSync(file,'utf8'),before);
 for(let i=0;i<260;i++){at++;reopened.receive('group:1',String(i+1));}assert.ok(reopened.snapshot().traces.length<=200);reopened.flush();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('缺失开始时间不会伪造耗时；可区分欠费、超时、鉴权、网络',()=>{
 const d=createMessageDiagnostics({now:()=>5000});d.sent('group:1');const s=d.snapshot();assert.equal(s.traces.length,0);
 for(const [value,code] of [['Insufficient Balance','balance'],['stream idle timeout','timeout'],['HTTP 401','auth'],['ECONNREFUSED','network']])assert.equal(classifyOperationalError(value).code,code);
 d.receive('group:1','4');d.block('group:1','budget_exceeded');assert.equal(d.snapshot().traces[0].status,'blocked');
});
test('模型错误后的通知不冒充成功回复；回合结束后晚发的回复仍归原来信',()=>{
 let at=1000;const d=createMessageDiagnostics({now:()=>at});d.receive('group:1','1');d.dispatch('group:1');d.model('group:1');at=2000;d.receive('group:1','2');
 d.end('group:1',{kind:'error',error:{message:'Insufficient Balance'}});d.sendStart('group:1');d.sent('group:1');
 const failed=d.snapshot().traces.find(x=>x.messageId==='1');assert.equal(failed.status,'error');assert.equal(failed.totalMs,null);assert.equal(d.snapshot().traces.find(x=>x.messageId==='2').status,'received');
 const e=createMessageDiagnostics({now:()=>at});e.receive('group:2','3');e.dispatch('group:2');e.model('group:2');at=3000;e.receive('group:2','4');e.end('group:2',{kind:'completed'});e.sendStart('group:2');e.sent('group:2');
 assert.equal(e.snapshot().traces.find(x=>x.messageId==='3').status,'replied');assert.equal(e.snapshot().traces.find(x=>x.messageId==='4').status,'received');
});


test('主动机会单独计时，不能把半小时前来信算成回复延迟', () => {
 let at=1000;const d=createMessageDiagnostics({now:()=>at});
 d.receive('group:1','7');at=1801000;d.dispatch('group:1','proactiveCheck');d.model('group:1');at+=5000;d.sent('group:1');d.end('group:1',{kind:'completed'});
 const t=d.snapshot().traces.find(x=>x.status==='replied');
 assert.equal(t.messageId,null);assert.equal(t.receivedAt,null);assert.equal(t.totalMs,null);assert.equal(t.modelMs,5000);
 assert.equal(d.snapshot().traces.find(x=>x.messageId==='7').status,'received');
});
test('合批替换旧排队记录后重启，不制造虚假中断', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-diag-batch-'));const file=path.join(dir,'diag.json');
 try {
  const d=createMessageDiagnostics({file,now:()=>1000});d.receive('group:1','1');d.queue('group:1','followup');d.receive('group:1','2');d.queue('group:1','atMention');d.flush();
  const reopened=createMessageDiagnostics({file});const traces=reopened.snapshot().traces;
  assert.equal(traces.find(x=>x.messageId==='1').status,'received');
  assert.equal(traces.find(x=>x.messageId==='1').queuedAt,null);
  assert.equal(traces.find(x=>x.messageId==='2').status,'interrupted');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('工具 JSON 错误有独立且不泄露参数的分类', () => {
 assert.deepEqual(classifyOperationalError('DeepSeek Messages stream: tool input is invalid JSON secret'),{code:'tool_json',message:'模型工具参数格式错误'});
});

test('历史主动接话记录读取时纠正耗时展示，保存的原始时间不变', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-diag-old-'));const file=path.join(dir,'diag.json');
 try {
  const original=JSON.stringify({traces:[{key:'group:1',messageId:'9',status:'replied',reason:'proactiveCheck',receivedAt:1000,dispatchedAt:1801000,modelAt:1801000,sentAt:1806000}],incidents:[]});
  fs.writeFileSync(file,original);const d=createMessageDiagnostics({file});const trace=d.snapshot().traces[0];
  assert.equal(trace.totalMs,null);assert.equal(trace.receivedAt,1000);assert.equal(trace.modelMs,5000);assert.equal(fs.readFileSync(file,'utf8'),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
