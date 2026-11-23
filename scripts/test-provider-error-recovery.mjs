import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeHarness} from './audit-bridge-harness.mjs';

async function runEnd(kind, check, options={}) {
  const h=await bridgeHarness({config:{socialV2:{proactive:{enabled:false},economy:{hostObservation:true},wake:{noActionLimit:1,maxWakeConfigReminders:2}}}});
  try {
    h.setMode('reserved2');
    const key='group:456',sid=await h.ensureSession(key),st=h.getSocialV2State(key);
    st.wakeConfig.triggers.probability=0.123;
    st.wakeConfig.noActionCount=0;
    h.pendingWakeKeys.add(key);
    if(options.paused) h.socialV2.paused=true;
    let drained;
    const done=new Promise(resolve=>{drained=resolve;});
    const events=[...(options.missingStart?[]:[{type:'turn/start',data:{turn:1}}]),
      ...(options.providerRetried ? [{type:'llm/retry-started',data:{turn:1,step:1,retry:1}}] : []),
      ...(options.tool ? [{type:'tool/call',data:{callId:'call1',name:'qq_send_message',arguments:{message:'已回复'}}},{type:'tool/result',data:{message:{source:{callId:'call1'},content:[{type:'text',text:'ok'}]}}}] : []),
      {type:'turn/end',data:{turn:1,reason:kind==='error'?{kind,error:{message:options.errorMessage || 'DeepSeek Messages stream idle timeout'}}:{kind}}}];
    h.api.events.mux=()=>({async *[Symbol.asyncIterator](){
      for(let n=0;n<(options.repeat||1);n++) {
        for(const event of events)yield{payload:{type:'session/event',sessionId:sid,event}};
      }
      drained();await new Promise(()=>{});
    }});
    h.pumpMux().catch(()=>{});
    const timer=setTimeout(()=>drained(new Error('事件处理未完成')),1000);
    try{const err=await done;if(err)throw err;}finally{clearTimeout(timer);}
    // 投递队列包含异步鉴权/模型设置，等两个事件循环再检查已接受的请求。
    await new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));
    await check({h,key,st,sid});
  }finally{await h.close();}
}

for(const kind of ['error','aborted'])test(`${kind} 结束后不创建收尾提醒、不计无行动或重置群配置`,()=>runEnd(kind,async({h,key,st})=>{
  assert.equal(h.calls.prompts.length,0,'失败不能追加新的模型回合');
  assert.equal(h.pendingWakeKeys.has(key),false);
  assert.equal(h.wakeConfigMissCount.has(key),false);
  assert.equal(st.wakeConfig.noActionCount,0);
  assert.equal(st.wakeConfig.triggers.probability,0.123);
  assert.equal(h.calls.sent.length,1,'只发一次原有错误/中止通知');
}));

test('工具执行后再超时也不重放工具或追加模型收尾',()=>runEnd('error',async({h,key})=>{
  assert.equal(h.calls.prompts.length,0);
  assert.equal(h.pendingWakeKeys.has(key),false);
  assert.equal(h.calls.sent.length,1);
},{tool:true}));

test('正常完成但未收尾时仍保留原有提醒机制',()=>runEnd('completed',async({h})=>{
  assert.equal(h.calls.prompts.length,1);
}));

const malformed='DeepSeek Messages stream: tool input is invalid JSON';
test('工具尚未执行的参数 JSON 错误只补试一次',()=>runEnd('error',async({h})=>{
  assert.equal(h.calls.prompts.length,1);
  assert.equal(h.calls.sent.length,0);
},{errorMessage:malformed}));
test('工具执行后参数 JSON 错误不得重放',()=>runEnd('error',async({h})=>{
  assert.equal(h.calls.prompts.length,0);
},{errorMessage:malformed,tool:true}));

test('DSH 已重试仍报工具 JSON 错误时不再重开整轮，只发送中文说明',()=>runEnd('error',async({h})=>{
  assert.equal(h.calls.prompts.length,0);
  assert.equal(h.calls.sent.length,1);
  assert.match(h.calls.sent[0].text,/工具参数.*再试一次/);
  assert.doesNotMatch(h.calls.sent[0].text,/DeepSeek Messages stream/);
},{errorMessage:malformed,providerRetried:true}));

test('补试再次失败不循环请求模型',()=>runEnd('error',async({h})=>{
  assert.equal(h.calls.prompts.length,1);
  assert.equal(h.calls.sent.length,1);
},{errorMessage:malformed,repeat:2}));
for(const flag of ['missingStart','paused']) test(`${flag} 不补试`,()=>runEnd('error',async({h})=>{
  assert.equal(h.calls.prompts.length,0);
},{errorMessage:malformed,[flag]:true}));
