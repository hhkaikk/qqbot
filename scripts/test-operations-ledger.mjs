import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTokenLedger} from '../src/token-ledger.js';
test('精确窗口只统计有时间的请求，基线不灌入今天、重放不翻倍、按会话拆分',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-budget-ledger-'));
 const from=Date.parse('2026-10-30T00:00:00+08:00'),to=from+86400000;
 try{
  const file=path.join(dir,'ledger.jsonl');const ledger=createTokenLedger({file,resolveKey:sid=>sid==='a'?'group:1':'private:2'});
  const add=(sid,seq,t)=>ledger.ingestEvent({sessionId:sid,event:{type:'assistant/message',seq,time:t,data:{turn:seq,step:1,usage:{inputTokens:100,cacheReadTokens:200,outputTokens:10}}},model:'deepseek-flash'});
  add('a',1,from-1);add('a',2,from);add('b',3,to-1);add('b',4,to);
  ledger.ingestBaseline({sessionId:'a',projection:{asOfSeq:2,values:{tokenUsage:{inputTokens:99999999}}},at:from+1,model:'deepseek-flash'});
  add('a',2,from);
  const data=ledger.period({from,to});assert.equal(data.steps,2);assert.equal(data.buckets.cacheMiss,200);assert.equal(data.buckets.cacheHit,400);assert.equal(data.buckets.output,20);
  assert.equal(data.conversations.length,2);assert.ok(data.cost>0);assert.equal(data.coverage,'recorded_requests_only');
  const reopened=createTokenLedger({file});assert.equal(reopened.period({from,to}).steps,2);
  assert.throws(()=>ledger.period({from:to,to:from}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('无日期历史不归今天；账本不可读和窗口可能被淘汰时明确不可核对',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-budget-coverage-'));const from=Date.parse('2026-10-30T00:00:00+08:00'),at=from+1000;
 try{
  const file=path.join(dir,'history');let l=createTokenLedger({file,now:()=>at,maxLines:2});
  l.ingestSnapshotRecords({sessionId:'s',records:[{type:'assistant/message',seq:1,data:{turn:1,step:1,usage:{inputTokens:1000000}}}]});
  assert.equal(l.period({from,to:from+86400000}).steps,0);
  l.compact();l=createTokenLedger({file,now:()=>at,maxLines:2});assert.equal(l.period({from,to:from+86400000}).steps,0);
  for(let i=2;i<7;i++)l.ingestEvent({sessionId:'s',event:{type:'assistant/message',seq:i,time:at+i,data:{turn:i,step:1,usage:{inputTokens:100}}}});
  assert.equal(l.period({from,to:from+86400000}).available,false,'淘汰后不得用缩水数字冒充完整当日数据');
  assert.equal(createTokenLedger({file:dir}).period({from,to:from+86400000}).available,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
