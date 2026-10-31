import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';

async function fixture(run) {
  const h=await bridgeHarness({config:{dsh:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'},unrelated:{keep:true}}});
  const server=h.startConsoleServer();
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(route,{method='GET',body,headers={}}={})=>{
    const response=await fetch(base+route,{method,headers:{'x-console-token':'fixture-console-token',...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  };
  try{await run(h,call,server);}finally{await new Promise(resolve=>server.close(resolve));await h.close();}
}

test('管理接口局部更新保留凭据、管理员、私聊名单和未知配置，保存后立即撤销旧会话权限',async()=>fixture(async(h,call)=>{
  h.setMode('reserved2');const state=h.getSocialV2State('group:456');const token=state.agentToken;
  const before=JSON.parse(fs.readFileSync(path.join(h.temp,'config.json')));
  const result=await call('/api/whitelist',{method:'POST',body:{allow:{groups:[789,'789']}}});
  assert.equal(result.status,200);assert.deepEqual(result.body.allow.groups,[789]);
  const after=JSON.parse(fs.readFileSync(path.join(h.temp,'config.json')));
  assert.deepEqual(after.allow.private,before.allow.private);assert.equal(after.ownerQQ,before.ownerQQ);
  assert.equal(after.consoleToken,before.consoleToken);assert.deepEqual(after.dsh,before.dsh);assert.deepEqual(after.unrelated,before.unrelated);
  const read=await call('/api/whitelist');assert.deepEqual(read.body.allow.groups,[789]);
  const denied=await call('/api/socialV2/state?key=group:456',{headers:{'x-agent-call':'1','x-agent-token':token}});
  assert.equal(denied.status,403);
}));

test('管理写入拒绝非法管理员和损坏配置，不覆盖文件和运行配置',async()=>fixture(async(h,call)=>{
  const file=path.join(h.temp,'config.json');const original=fs.readFileSync(file,'utf8');
  assert.equal((await call('/api/whitelist',{method:'POST',body:{ownerQQ:'bad'}})).status,400);
  assert.equal(fs.readFileSync(file,'utf8'),original);
  for(const raw of ['null','[]','{broken']){
    fs.writeFileSync(file,raw);
    for(const [route,body] of [['/api/whitelist',{allow:{groups:[789]}}],['/api/dsh/effort',{reasoningEffort:'low'}]]){
      assert.equal((await call(route,{method:'POST',body})).status,500);assert.equal(fs.readFileSync(file,'utf8'),raw);
    }
    assert.equal(h.cfg.dsh.reasoningEffort,'high');assert.deepEqual(Array.from(h.cfg.allow.groups),['456']);
  }
}));

test('管理接口统一鉴权、智能体隔离和跨站保护在读写前执行',async()=>fixture(async(h,call)=>{
  const file=path.join(h.temp,'config.json');const before=fs.readFileSync(file,'utf8');
  const token=h.getSocialV2State('group:456').agentToken;let modelCalls=0;
  h.api.callUnary=async()=>{modelCalls++;throw new Error('must not run');};
  for(const [route,body] of [['/api/whitelist',{ownerQQ:789}],['/api/dsh/effort',{reasoningEffort:'low'}],['/api/dsh/model',undefined]]){
    for(const extra of [{'x-console-token':'wrong'},{'x-agent-call':'1'},{'x-agent-token':token},{'x-agent-token':''}]){
      const r=await call(route,{method:body===undefined?'GET':'POST',body,headers:extra});
      assert.equal(r.status,extra['x-console-token']?401:403);
    }
  }
  assert.equal((await call('/api/dsh/effort',{method:'POST',body:{reasoningEffort:'low'},headers:{origin:'https://evil.invalid'}})).status,403);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(modelCalls,0);
}));

test('模型目录并发合并、档位过滤与更新不创建模型回合',async()=>fixture(async(h,call,server)=>{
  let modelCalls=0;let release;
  const gate=new Promise(resolve=>{release=resolve;});
  // 等两个请求真正到达 HTTP 服务，再让它们的路由微任务进入在途查询。
  // 不使用固定等待窗口，避免慢机器把第二个请求误测成下一次查询。
  let arrivals=0;let ready;const arrived=new Promise(resolve=>{ready=resolve;});
  server.on('request',req=>{if(req.url==='/api/dsh/model'&&++arrivals===2)ready();});
  h.api.callUnary=async(method)=>{assert.equal(method,'session.modelCatalog');modelCalls++;await gate;return {result:{ok:true,value:{groups:[{id:'deepseek-official',models:[{id:'deepseek-flash',reasoning:{efforts:[{id:'low',name:'低'},{id:'high',name:'高'},{id:'off',name:'关闭'}],defaultEffort:'high'}}]}]}}};};
  const pending=Promise.all([call('/api/dsh/model'),call('/api/dsh/model')]);pending.catch(()=>{});
  let barrierTimer;
  try{
    await Promise.race([arrived,new Promise((_,reject)=>{barrierTimer=setTimeout(()=>reject(new Error('模型目录请求未到齐')),4500);})]);
    await new Promise(resolve=>setImmediate(resolve));
  }finally{clearTimeout(barrierTimer);release();}
  const results=await pending;
  assert.equal(modelCalls,1);for(const r of results){assert.equal(r.status,200);assert.deepEqual(r.body.options,['low','high']);assert.equal(r.body.catalogSource,'dsh');assert.equal(r.body.providerDefault,'high');assert.equal(r.body.globalSideEffect,true);}
  assert.equal((await call('/api/dsh/effort',{method:'POST',body:{reasoningEffort:' off '}})).status,400);
  assert.equal((await call('/api/dsh/effort',{method:'POST',body:{reasoningEffort:' LOW '}})).status,200);
  assert.equal(h.cfg.dsh.reasoningEffort,'low');assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp,'config.json'))).dsh.reasoningEffort,'low');
  assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.created.length,0);assert.equal(h.calls.sent.length,0);
}));

test('模型目录故障保留原回退档位，未知路径和方法仍为404',async()=>fixture(async(h,call)=>{
  h.api.callUnary=async()=>{throw new Error('fixture unavailable');};
  const r=await call('/api/dsh/model');assert.equal(r.status,200);assert.equal(r.body.catalogSource,'fallback');assert.deepEqual(r.body.options,['low','high','max']);assert.equal(r.body.reasoningEffort,'high');
  assert.equal((await call('/api/dsh/effort')).status,404);
  assert.equal((await call('/api/whitelist',{method:'PATCH',body:{}})).status,404);
  assert.equal((await call('/api/dsh/model/unknown')).status,404);
}));

test('热更新档位只在下一次会话使用时重新选模，沿用同一个会话',async()=>fixture(async(h,call)=>{
  h.setMode('reserved2');const selections=[];
  h.api.sessions.selectModel=async params=>{selections.push({...params});return {result:{ok:true,value:{selected:params}}};};
  const id=await h.ensureSession('group:456');assert.equal(selections.length,1);assert.equal(selections[0].reasoningEffort,'high');
  assert.equal(await h.ensureSession('group:456'),id);assert.equal(selections.length,1);
  assert.equal((await call('/api/dsh/effort',{method:'POST',body:{reasoningEffort:'low'}})).status,200);
  assert.equal(selections.length,1,'保存设置不能立即重选正在使用的会话');
  assert.equal(await h.ensureSession('group:456'),id);assert.equal(selections.length,2);assert.equal(selections[1].reasoningEffort,'low');
  assert.equal(await h.ensureSession('group:456'),id);assert.equal(selections.length,2);assert.equal(h.calls.created.length,1);assert.equal(h.calls.prompts.length,0);
}));
