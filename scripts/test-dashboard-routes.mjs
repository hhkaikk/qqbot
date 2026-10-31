import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';

test('指定的十位登录密码重启后仍生效，空密码和旧凭据均拒绝',async()=>{
 const password='testpass12';const h=await bridgeHarness({config:{consoleToken:password}});
 const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/dashboard/api/overview`;
 try{
  for(const token of ['', 'fixture-console-token','wrong-pass']){
   const r=await fetch(url,{headers:{'x-console-token':token}});assert.equal(r.status,401);await r.arrayBuffer();
  }
  const r=await fetch(url,{headers:{'x-console-token':password}});assert.equal(r.status,200);await r.arrayBuffer();
 }finally{await new Promise(r=>server.close(r));await h.close();}
});

test('更新登录密码立即撤销旧凭据，持久保存并保持智能体隔离',async()=>{
 const h=await bridgeHarness();const st=h.getSocialV2State('group:456');
 const server=h.startConsoleServer();await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const old='fixture-console-token',password='newpass123';
 try{
  const changed=await fetch(base+'/api/console/token',{method:'POST',headers:{'x-console-token':old,'content-type':'application/json'},body:JSON.stringify({token:password})});
  assert.equal(changed.status,200);await changed.arrayBuffer();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp,'config.json'))).consoleToken,password);
  assert.equal(fs.readFileSync(path.join(h.temp,'state/console-token'),'utf8').trim(),password);
  for(const [headers,status] of [[{'x-console-token':old},401],[{'x-console-token':password},200],[{'x-console-token':password,'x-agent-token':st.agentToken},403]]){
   const r=await fetch(base+'/dashboard/api/overview',{headers});assert.equal(r.status,status);await r.arrayBuffer();
  }
  const short=await fetch(base+'/api/console/token',{method:'POST',headers:{'x-console-token':password,'content-type':'application/json'},body:JSON.stringify({token:'short'})});assert.equal(short.status,400);await short.arrayBuffer();
 }finally{await new Promise(r=>server.close(r));await h.close();}
});

test('真实桥接工作台：公开外壳、API鉴权与智能体隔离、读取不改变未读',async()=>{
 const h=await bridgeHarness();const st=h.getSocialV2State('group:456');h.appendSocialV2Message('group:456','群友','测试聊天','测试聊天',false,false,'id-1',[],'789');
 h.state.sessions['group:456']='expired-session';h.v2TurnStartAt.set('expired-session',Date.now()-h.TURN_BUSY_LEASE_MS-1000);h.collectors.set('expired-session',{});
 fs.mkdirSync(path.join(h.temp,'public'));for(const file of ['dashboard.html','dashboard.css','dashboard.js','dashboard-avatar.jpg'])fs.writeFileSync(path.join(h.temp,'public',file),`fixture-${file}`);
 const server=h.startConsoleServer();await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;const admin={'x-console-token':'fixture-console-token'};
 try{
  assert.equal((await fetch(base+'/dashboard/')).status,200);
  assert.match((await fetch(base+'/dashboard/dashboard-avatar.jpg')).headers.get('content-type'),/^image\/jpeg/);
  assert.equal((await fetch(base+'/dashboard/api/overview')).status,401);
  assert.equal((await fetch(base+'/dashboard/api/overview',{headers:{'x-console-token':'wrong'}})).status,401);
  for(const extra of [{'x-agent-call':'1'},{'x-agent-token':st.agentToken}])assert.equal((await fetch(base+'/dashboard/api/overview',{headers:{...admin,...extra}})).status,403);
  const r=await fetch(base+'/dashboard/api/overview',{headers:admin});assert.equal(r.status,200);const data=await r.json();assert.equal(data.conversations[0].key,'group:456');assert.ok(!JSON.stringify(data).includes(st.agentToken));
  assert.equal(h.turnLeaseNoted.size,0,'只读工作台不能通过忙闲判定写入租约备注或日志');
  const before=st.unread.length;const detail=await (await fetch(base+'/dashboard/api/conversation?key=group:456',{headers:admin})).json();assert.equal(detail.messages[0].text,'测试聊天');assert.equal(st.unread.length,before);
  assert.equal((await fetch(base+'/dashboard/api/overview',{method:'POST',headers:{...admin,'content-type':'application/json'},body:'{}'})).status,405);
  assert.equal((await fetch(base+'/dashboard/api/conversation?key=../../config.json',{headers:admin})).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));await h.close();}
});
