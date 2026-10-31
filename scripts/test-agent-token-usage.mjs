import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeHarness} from './audit-bridge-harness.mjs';

async function fixture(run){
 const h=await bridgeHarness({config:{allow:{private:['123'],groups:['456','789']}}});h.setMode('reserved2');
 const own=h.getSocialV2State('group:456'),other=h.getSocialV2State('group:789');
 const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
 const request=async(path,token=own.agentToken,method='GET')=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'x-console-token':'fixture-console-token','x-agent-call':'1',...(token===null?{}:{'x-agent-token':token}),'content-type':'application/json'},signal:AbortSignal.timeout(3000)});
  return{status:response.status,body:await response.json()};
 };
 const ingest=async(key,input,output)=>{
  const sessionId=await h.ensureSession(key);
  assert.equal(h.tokenLedger.ingestEvent({sessionId,model:'deepseek-flash',event:{seq:1,time:Date.now(),type:'assistant/message',data:{turn:1,step:1,usage:{inputTokens:input,outputTokens:output,cacheReadTokens:0}}}}),true);
 };
 try{await run({h,own,other,request,ingest});}finally{await new Promise(r=>server.close(r));await h.close();}
}

test('自己的状态返回真实会话账本汇总，不包含其他会话或请求明细',()=>fixture(async({request,ingest})=>{
 await ingest('group:456',120,30);await ingest('group:789',8000,9000);
 const response=await request('/api/socialV2/state?key=group:456');assert.equal(response.status,200);
 const usage=response.body.tokenUsage;assert.equal(usage.available,true);assert.equal(usage.totalTokens,150);assert.equal(usage.inputTokens,120);assert.equal(usage.outputTokens,30);
 assert.equal(usage.scope,'current_conversation');assert.equal(usage.period,'recorded_total');assert.ok(usage.estimatedCost.amount>=0);
 assert.doesNotMatch(JSON.stringify(usage),/fixture-\d|group:789|sessionIds|\"turns\"|17000/);
}));

test('尚无账本记录明确不可用，不伪报零消耗',()=>fixture(async({request})=>{
 const response=await request('/api/socialV2/state?key=group:456');assert.equal(response.body.tokenUsage.available,false);assert.equal(response.body.tokenUsage.totalTokens,null);
}));

test('不能用当前会话令牌查询其他群，缺失、错误或撤销权限均拒绝',()=>fixture(async({h,request})=>{
 assert.equal((await request('/api/socialV2/state?key=group:789')).status,403);
 for(const token of [null,'','invalid'])assert.equal((await request('/api/socialV2/state?key=group:456',token)).status,403);
 h.cfg.allow.groups=[];assert.equal((await request('/api/socialV2/state?key=group:456')).status,403);
}));

test('依然不能读取全局用量或重置账本；关闭状态工具时拒绝查询',()=>fixture(async({h,request})=>{
 for(const path of ['/api/tokens/summary','/api/tokens/recent','/api/tokens/turns?key=group:789'])assert.equal((await request(path)).status,403);
 assert.equal((await request('/api/tokens/reset',undefined,'POST')).status,403);
 h.cfg.socialV2.tools.socialState=false;assert.equal((await request('/api/socialV2/state?key=group:456')).status,403);
}));
