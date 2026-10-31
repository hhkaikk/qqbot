import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTokenLedger} from '../src/token-ledger.js';
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-token-replay-'));const file=path.join(dir,'tokens.jsonl');return {file,open:(options={})=>createTokenLedger({file,resolveKey:()=> 'group:fixture',...options}),close:()=>fs.rmSync(dir,{recursive:true,force:true})};}
const event=(seq,step,input)=>({type:'assistant/message',seq,time:1793203534644,data:{turn:64,step,usage:{inputTokens:input,outputTokens:0}}});
const retry={type:'llm/retry-started',seq:15,time:1793203534000,data:{turn:64,step:1,retry:1}};
function seed(ledger){for(const e of [event(10,1,100),retry,event(20,1,200),{...retry,seq:25,data:{turn:64,step:2,retry:1}},event(30,2,300)])ledger.ingestEvent({sessionId:'s',event:e});}
test('同一seq在重试轴移到下一步后重放，不产生额外付费记录',()=>{
 const h=fixture();try{const l=h.open();seed(l);assert.equal(l.summary().totals.totalTokens,600);l.ingestSnapshotRecords({sessionId:'s',records:[event(20,1,200)]});assert.equal(l.summary().totals.totalTokens,600);assert.equal(l.recent(10).length,3);}finally{h.close();}
});
test('重启后重放仍幂等，不丢不同seq的真实失败/重试用量',()=>{
 const h=fixture();try{seed(h.open());const l=h.open();l.ingestEvent({sessionId:'s',event:event(20,1,200)});assert.equal(l.summary().totals.totalTokens,600);assert.equal(l.recent(10).length,3);}finally{h.close();}
});
test('历史账本已保存的同事件不同retry副本，载入后不重复汇总',()=>{
 const h=fixture();try{seed(h.open());const records=fs.readFileSync(h.file,'utf8').trim().split('\n').map(JSON.parse);const duplicate={...records.find(x=>x.seq===20),retry:0};fs.appendFileSync(h.file,JSON.stringify(duplicate)+'\n');assert.equal(h.open().summary().totals.totalTokens,600);}finally{h.close();}
});
test('不同会话相同seq是不同请求，不能跨会话去重',()=>{
 const h=fixture();try{const l=h.open();for(const sessionId of ['a','b'])l.ingestEvent({sessionId,event:event(20,1,200)});assert.equal(l.summary().totals.totalTokens,400);}finally{h.close();}
});
test('流式attempt被最终结算覆盖后，换轴重放attempt也不能重复计费',()=>{
 const h=fixture();try{
  let l=h.open({maxLines:3});const attempt={...event(20,1,200),type:'assistant/attempt',data:{turn:64,step:1,stream:[{usage:{inputTokens:200,outputTokens:0}}]}};
  for(const e of [event(10,1,100),retry,attempt,event(21,1,210),{...retry,seq:25,data:{turn:64,step:2,retry:1}},event(30,2,300)])l.ingestEvent({sessionId:'s',event:e});
  for(const restart of [false,true]){
   if(restart)l=h.open();l.ingestEvent({sessionId:'s',event:attempt});assert.equal(l.summary().totals.totalTokens,610);
  }
 }finally{h.close();}
});
