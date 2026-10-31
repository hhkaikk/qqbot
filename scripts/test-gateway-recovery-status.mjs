import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {readGatewayRecoveryStatus} from '../src/gateway-recovery-status.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';

function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-recovery-status-'));const file=path.join(root,'status.json');return{file,write:x=>fs.writeFileSync(file,JSON.stringify(x)),close:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('恢复状态仅取允许字段，不透传任意错误或凭据',()=>{
 const h=fixture();try{
  h.write({version:1,phase:'needs_action',reason:'device',requiresAction:true,checkedAt:100,token:'fixture-secret',passwordMd5:'a'.repeat(32)});
  const data=readGatewayRecoveryStatus({file:h.file,now:101000});assert.equal(data.phase,'needs_action');assert.match(data.message,/手机/);
  assert.ok(!JSON.stringify(data).includes('fixture-secret'));assert.equal(data.requiresAction,true);
 }finally{h.close();}
});
test('缺失、损坏、超大和过期状态不会被标成在线',()=>{
 const h=fixture();try{
  assert.equal(readGatewayRecoveryStatus({file:h.file}),null);
  for(const raw of ['{bad','x'.repeat(20000),JSON.stringify({phase:'online',checkedAt:1})]){
   fs.writeFileSync(h.file,raw);const r=readGatewayRecoveryStatus({file:h.file,now:1000000});assert.equal(r.phase,'unknown');assert.equal(r.stale,true);
  }
 }finally{h.close();}
});
test('管理状态能看到恢复状态，智能体视图仍不包含此字段',async()=>{
 const h=await bridgeHarness({globals:{readGatewayRecoveryStatus:()=>({phase:'needs_action',reason:'device',message:'需要手机确认'})}});
 const server=h.startConsoleServer();await new Promise(resolve=>server.once('listening',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/status`;
  const admin=await (await fetch(url,{headers:{'x-console-token':'fixture-console-token'}})).json();assert.equal(admin.gatewayRecovery.reason,'device');
  const agent=await (await fetch(url,{headers:{'x-console-token':'fixture-console-token','x-agent-call':'1'}})).json();assert.equal(agent.gatewayRecovery,undefined);
 }finally{await new Promise(resolve=>server.close(resolve));await h.close();}
});
test('界面显示人工验证/恢复中，桥接断开时不把旧在线状态覆盖成已连接',()=>{
 const html=fs.readFileSync(new URL('../public/console.html',import.meta.url),'utf8');
 const source=html.match(/function renderGatewayRecovery\(recovery, upstream\) \{([\s\S]*?)\n\}/)?.[0];assert.ok(source);
 const nodes={metricSnowluma:{textContent:'未连接',className:''},metricSnowlumaHint:{textContent:''}};
 const context=vm.createContext({document:{getElementById:id=>nodes[id]}});vm.runInContext(source+';globalThis.render=renderGatewayRecovery',context);
 context.render({phase:'needs_action',message:'请确认手机',requiresAction:true},{});assert.equal(nodes.metricSnowluma.textContent,'需要处理');assert.equal(nodes.metricSnowlumaHint.textContent,'请确认手机');
 context.render({phase:'recovering',message:'正在恢复'},{});assert.equal(nodes.metricSnowluma.textContent,'恢复中');
 nodes.metricSnowluma.textContent='未连接';context.render({phase:'online',message:'QQ已在线'},{connected:false});assert.equal(nodes.metricSnowluma.textContent,'未连接');
});
