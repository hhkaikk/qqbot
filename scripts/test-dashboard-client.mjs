import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(){
 const pending=[];const nodes=new Map();
 const node=()=>({value:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},append(){},setAttribute(){},replaceChildren(){},scrollHeight:0,clientHeight:0,scrollTop:0});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},querySelectorAll(){return[];},createElement:node,createElementNS:node,createTextNode:()=>node()};
 const source=fs.readFileSync(new URL('../public/dashboard.js',import.meta.url),'utf8');
 const cut=source.indexOf("  $('loginForm').addEventListener");assert.ok(cut>0);
 const context=vm.createContext({document,URL,AbortController,location:{href:'http://localhost/dashboard/'},history:{replaceState(){}},console,Date,Intl,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},fetch:()=>new Promise(resolve=>pending.push(resolve))});
  vm.runInContext(source.slice(0,cut)+'globalThis.audit={state,loadUsage,loadDetail,loadOperations,handleError,lock};})();',context);
 const a=context.audit;a.state.connected=true;a.state.token='old-access';a.state.selectedKey='group:1';a.state.overview={conversations:[]};
 return {...a,pending};
}
const response=(status,data)=>({status,ok:status===200,json:async()=>data});
const detail=tag=>({key:'group:1',tag,retainedCount:0,messages:[],memories:{people:[],topics:[],thoughts:[]}});
test('折叠为图标的导航仍有明确的可访问名称',()=>{
 const html=fs.readFileSync(new URL('../public/dashboard.html',import.meta.url),'utf8');const buttons=html.match(/<button[^>]+data-page=[^>]+>/g);assert.equal(buttons.length,5);for(const button of buttons)assert.match(button,/aria-label="[^"]+"/);
});
for(const method of ['loadUsage','loadDetail'])test(`${method}：旧会话迟到的401不会锁掉新登录`,async()=>{
 const h=harness();const work=h[method]().catch(h.handleError);h.lock();h.state.connected=true;h.state.token='new-access';h.state.selectedKey='group:1';
 h.pending[0](response(401,{}));await work;assert.equal(h.state.connected,true);assert.equal(h.state.token,'new-access');
});
test('同一会话详情后发请求先返回时，旧数据不能覆盖新数据',async()=>{
 const h=harness();const old=h.loadDetail();const current=h.loadDetail();h.pending[1](response(200,detail('new')));await current;h.pending[0](response(200,detail('old')));await old;assert.equal(h.state.detail.tag,'new');
});
test('当前请求的401仍会锁定工作台',async()=>{
 const h=harness();const work=h.loadUsage().catch(h.handleError);h.pending[0](response(401,{}));await work;assert.equal(h.state.connected,false);assert.equal(h.state.token,'');
});
test('保存中锁定会清理保存标记，旧登录的运行数据401不能锁掉新登录',async()=>{
 const h=harness();h.state.budgetSaving=true;h.state.budgetDrafts={'group:1':'8'};
 const old=h.loadOperations().catch(h.handleError);h.lock();assert.equal(h.state.budgetSaving,false);assert.equal(Object.keys(h.state.budgetDrafts).length,0);
 h.state.connected=true;h.state.token='new-access';h.pending[0](response(401,{}));await old;assert.equal(h.state.connected,true);
});
