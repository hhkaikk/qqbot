import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createManagementRoutes,normalizeOwnerQQ,normalizeReasoningEffort} from '../src/management-routes.js';

function fixture(overrides={}) {
  const original={ownerQQ:123,allow:{private:[123],groups:[456]},deny:{private:[],groups:[]},dsh:{provider:'fixture',model:'chat',reasoningEffort:'high'},consoleToken:'private-fixture',other:{preserve:1}};
  const config=structuredClone(original);let file=structuredClone(original);
  const calls={read:0,write:0,access:0,model:0,catalog:0,logs:[]};
  const handle=createManagementRoutes({config,
    readConfig:()=>{calls.read++;return structuredClone(file);},
    writeConfig:value=>{calls.write++;file=structuredClone(value);},
    onAccessChanged:()=>{calls.access++;},onModelChanged:()=>{calls.model++;},
    getModelCatalog:async()=>{calls.catalog++;return {groups:[]};},log:value=>calls.logs.push(value),...overrides,
  });
  const call=async(route,{method='GET',body={},headers={}}={})=>{
    let response;let bodyReads=0;
    const handled=await handle({method,headers},new URL(route,'http://localhost'),(data,status=200)=>{response={status,data};},async()=>{bodyReads++;return body;});
    return {handled,response,bodyReads};
  };
  return {config,calls,call,file:()=>file};
}

test('归一化函数保持启动读取与接口保存相同规则',()=>{
  for(const value of ['',null,undefined])assert.equal(normalizeOwnerQQ(value),null);
  assert.equal(normalizeOwnerQQ(' 123 '),123);
  for(const value of ['-1','abc',1.5,'9007199254740992'])assert.throws(()=>normalizeOwnerQQ(value));
  assert.equal(normalizeReasoningEffort(' HIGH '),'high');
  for(const value of ['off','',undefined])assert.throws(()=>normalizeReasoningEffort(value));
});

test('新模块未知路径无副作用，智能体标记在任何读取与模型调用之前拒绝',async()=>{
  const h=fixture();
  assert.equal((await h.call('/api/status')).handled,false);
  assert.equal((await h.call('/api/dsh/model',{method:'POST'})).handled,false);
  for(const headers of [{'x-agent-token':''},{'x-agent-token':'token'},{'x-agent-call':'1'}]){
    const r=await h.call('/api/whitelist',{method:'POST',headers});assert.equal(r.response.status,403);assert.equal(r.bodyReads,0);
    assert.equal((await h.call('/api/dsh/model',{headers})).response.status,403);
  }
  assert.equal(h.calls.read,0);assert.equal(h.calls.write,0);assert.equal(h.calls.catalog,0);
});

test('配置写入失败时不提前改变内存或触发权限与模型协调',async()=>{
  const h=fixture({writeConfig:()=>{throw new Error('fixture write failed');}});const before=structuredClone(h.config);
  await assert.rejects(h.call('/api/whitelist',{method:'POST',body:{ownerQQ:789,allow:{groups:[]}}}),/fixture write failed/);
  await assert.rejects(h.call('/api/dsh/effort',{method:'POST',body:{reasoningEffort:'low'}}),/fixture write failed/);
  assert.deepEqual(h.config,before);assert.equal(h.calls.access,0);assert.equal(h.calls.model,0);
});

test('局部保存只改对应字段，成功后再执行协调且不改接口响应结构',async()=>{
  const h=fixture();
  const wl=await h.call('/api/whitelist',{method:'POST',body:{ownerQQ:'',allow:{groups:[]}}});
  assert.deepEqual(wl.response,{status:200,data:{ok:true,allow:{private:[123],groups:[]},deny:{private:[],groups:[]},ownerQQ:null}});
  assert.equal(h.calls.access,1);assert.equal(h.file().consoleToken,'private-fixture');assert.deepEqual(h.file().other,{preserve:1});
  const effort=await h.call('/api/dsh/effort',{method:'POST',body:{reasoningEffort:' MAX '}});
  assert.deepEqual(effort.response,{status:200,data:{ok:true,reasoningEffort:'max'}});assert.equal(h.config.dsh.reasoningEffort,'max');assert.equal(h.calls.model,1);
  assert.equal(h.calls.catalog,0);
});

test('模型查询合并只限在途请求，失败去重日志后可再次查询恢复',async()=>{
  let calls=0;let reject;let broken=true;
  const gate=new Promise((_,fail)=>{reject=fail;});
  const h=fixture({getModelCatalog:async()=>{calls++;if(broken)await gate;return {groups:[{id:'fixture',models:[{id:'chat',reasoning:{efforts:[{id:'high',name:'高'}],defaultEffort:'high'}}]}]};}});
  const pending=[h.call('/api/dsh/model'),h.call('/api/dsh/model')];reject(new Error('same failure'));
  const results=await Promise.all(pending);assert.equal(calls,1);assert.equal(h.calls.logs.length,1);
  for(const r of results)assert.equal(r.response.data.catalogSource,'fallback');
  assert.equal((await h.call('/api/dsh/model')).response.data.catalogSource,'fallback');assert.equal(h.calls.logs.length,1);
  broken=false;const recovered=await h.call('/api/dsh/model');assert.equal(recovered.response.data.catalogSource,'dsh');assert.deepEqual(recovered.response.data.options,['high']);assert.equal(calls,3);
});
