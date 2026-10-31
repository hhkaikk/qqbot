import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createSpendGuard,beijingDayWindow} from '../src/spend-guard.js';
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-guard-'));let at=Date.parse('2026-10-30T12:00:00+08:00'),cost=0,steps=0;
 const opts={policyFile:path.join(dir,'policy.json'),stateFile:path.join(dir,'state.json'),now:()=>at,ledger:{period:({from,to})=>({available:true,currency:'CNY',symbol:'¥',from,to,cost,steps,buckets:{cacheHit:0,cacheMiss:0,cacheWrite:0,output:0},conversations:[{key:'group:1',cost,steps}]})}};
 return{open:()=>createSpendGuard(opts),setCost:v=>cost=v,setSteps:v=>steps=v,advance:ms=>at+=ms,dir,close:()=>fs.rmSync(dir,{recursive:true,force:true})};}
test('北京时间日界准确，未知用量不冒充零；未设金额上限不擅自停用',()=>{
 const day=beijingDayWindow(Date.parse('2026-10-29T16:00:00Z'));assert.equal(day.day,'2026-10-30');assert.equal(day.from,Date.parse('2026-10-29T16:00:00Z'));
 const h=fixture();try{const g=h.open();h.setCost(99);assert.equal(g.allow('group:1','probability').allowed,true);const bad=createSpendGuard({ledger:{period(){throw Error('no');}}});assert.equal(bad.snapshot().today.available,false);}finally{h.close();}
});
test('达到金额预算阻止自动投递，但私聊、@、名字和管理员保留；80%提示',()=>{
 const h=fixture();try{const g=h.open();g.savePolicy({dailyLimit:5});h.setCost(4);assert.ok(g.snapshot().alerts.some(x=>x.code==='budget_warning'));h.setCost(5);assert.equal(g.allow('group:1','replyCheck').allowed,false);
 for(const reason of ['private','atMention','nameMention','admin'])assert.equal(g.allow('group:1',reason).allowed,true);
 h.advance(86400000);h.setCost(0);assert.equal(g.allow('group:1','probability').allowed,true);
 }finally{h.close();}
});
test('自动唤醒异常触发有界冷却，重启不绕过，其他会话和直接互动保留',()=>{
 const h=fixture();try{let g=h.open();for(let i=0;i<12;i++)assert.equal(g.allow('group:1','followup').allowed,true);
 assert.equal(g.allow('group:1','followup').allowed,false);g=h.open();assert.equal(g.allow('group:1','timeout').allowed,false);
 assert.equal(g.allow('group:2','followup').allowed,true);assert.equal(g.allow('group:1','atMention').allowed,true);
 h.advance(600001);assert.equal(g.allow('group:1','followup').allowed,true);
 }finally{h.close();}
});
test('计费请求激增也会冷却；读状态不改变文件；策略拒绝错型和未知字段',()=>{
 const h=fixture();try{const g=h.open();h.setSteps(80);assert.equal(g.allow('group:1','probability').allowed,false);const before=fs.readFileSync(path.join(h.dir,'state.json'),'utf8');g.snapshot();g.snapshot();assert.equal(fs.readFileSync(path.join(h.dir,'state.json'),'utf8'),before);
 for(const p of [{dailyLimit:-1},{dailyLimit:'5'},{anomalyEnabled:'false'},{extra:true},{conversationLimits:{'../../bad':4}}])assert.throws(()=>g.savePolicy(p));
 g.savePolicy({anomalyEnabled:false,dailyLimit:null});assert.equal(g.allow('group:1','followup').allowed,true);
 }finally{h.close();}
});
test('零预算停止自动聊天；预检触发冷却也能跨重启；不可用用量不能绕过金额预算',()=>{
 const h=fixture();try{let g=h.open();g.savePolicy({dailyLimit:0});assert.equal(g.allow('group:1','followup').allowed,false);g.savePolicy({dailyLimit:null});h.setSteps(80);assert.equal(g.allow('group:1','followup',{commit:false}).allowed,false);h.setSteps(0);g=h.open();assert.equal(g.allow('group:1','followup').allowed,false);
 const unavailable=createSpendGuard({ledger:{period:()=>({available:false})}});unavailable.savePolicy({dailyLimit:1});assert.equal(unavailable.allow('group:1','followup').allowed,false);
 }finally{h.close();}
});
