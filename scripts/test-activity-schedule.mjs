import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activityWakeAllowed,daytimeQuiet} from '../src/social-economy.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const config={socialV2:{activitySchedule:{enabled:true,holidays:[['2026-10-01','2026-10-07']],vacations:[['2026-11-04','2026-11-05']]}}};
const at=s=>Date.parse(s+'+08:00');
test('投递给模型的当前时间和潜水截止时间均按北京时间跨日显示',async()=>{
 const fixed=Date.parse('2026-11-14T16:07:09Z');
 class FixedDate extends Date {
  constructor(...args){super(...(args.length ? args : [fixed]));}
  static now(){return fixed;}
 }
 const h=await bridgeHarness({globals:{Date:FixedDate}});
 try{
  h.setMode('chat');
  await h.deliverPrompt('private:123','现在几点？');
  assert.match(h.calls.prompts[0].content[0].text,/【当前时间】2026\/11\/15 00:07:09（北京时间，UTC\+8）/);
  h.setMode('reserved2');
  const state=h.getSocialV2State('group:456');
  state.wakeConfig.infinite=false;
  state.wakeConfig.sleepUntil='2026-11-14T17:30:00.000Z';
  await h.deliverPrompt('group:456','现在几点？',{wakeReason:'atMention'});
  const prompt=h.calls.prompts[1].content[0].text;
  assert.match(prompt,/【当前时间】2026\/11\/15 00:07:09（北京时间，UTC\+8）/);
  assert.match(prompt,/有限至 2026\/11\/15 01:30:00（北京时间，UTC\+8）/);
 }finally{await h.close();}
});
test('北京时间工作日、21点边界、零点、周末、节日和个人假期',()=>{
 for(const [time,quiet] of [['2026-11-03T20:59:59',true],['2026-11-03T21:00:00',false],['2026-11-03T00:00:00',true],['2026-11-07T10:00:00',false],['2026-11-08T10:00:00',false],['2026-10-01T10:00:00',false],['2026-11-04T10:00:00',false]])assert.equal(daytimeQuiet(config,'group:456',at(time)),quiet,time);
 assert.equal(daytimeQuiet(config,'private:123',at('2026-11-03T10:00:00')),false);
 assert.equal(daytimeQuiet({},'group:456',at('2026-11-03T10:00:00')),false);
});
test('白天自动唤醒被阻止，明确呼叫保留',()=>{
 for(const reason of ['probability','question','keyword','followup','replyCheck','timeout','proactiveCheck','bootstrap','background'])assert.equal(activityWakeAllowed(config,'group:456',reason,at('2026-11-03T10:00:00')),false,reason);
 for(const reason of ['private','atMention','nameMention','admin'])assert.equal(activityWakeAllowed(config,'group:456',reason,at('2026-11-03T10:00:00')),true,reason);
});
test('真实投递入口：白天不调用模型，21点恢复，离线排队跨入白天被拦截',async()=>{
 const originalNow=Date.now;let now=at('2026-11-03T10:00:00');Date.now=()=>now;
 const h=await bridgeHarness({config});h.setMode('reserved2');
 try{
  const st=h.getSocialV2State('group:456');st.lastIncomingAt=now;
  await h.sendWakePromptV2('group:456','probability');assert.equal(h.calls.prompts.length,0);
  await h.sendWakePromptV2('group:456','atMention');assert.equal(h.calls.prompts.length,1);
 }finally{await h.close();Date.now=originalNow;}
 const g=await bridgeHarness({config});g.setMode('reserved2');
 Date.now=()=>now;
 try{
  now=at('2026-11-03T21:00:00');g.getSocialV2State('group:456').lastIncomingAt=now;
  g.setReady(false);await g.sendWakePromptV2('group:456','probability');
  now=at('2026-11-04T10:00:00'); // personal holiday still normal; use next workday instead
  now=at('2026-11-06T10:00:00');await g.checkDsh();assert.equal(g.calls.prompts.length,0);
 }finally{await g.close();Date.now=originalNow;}
 const k=await bridgeHarness({config});k.setMode('reserved2');Date.now=()=>at('2026-11-03T21:00:00');
 try{await k.sendWakePromptV2('group:456','probability');assert.equal(k.calls.prompts.length,1);}
 finally{await k.close();Date.now=originalNow;}
});
