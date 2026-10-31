import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NodeApiClient} from '../src/dsh-client.js';
const sockets=[];
class FakeSocket {
 static CONNECTING=0;static OPEN=1;static CLOSED=3;
 readyState=0;listeners=new Map();sent=[];
 constructor(){sockets.push(this);}
 addEventListener(name,fn){const list=this.listeners.get(name)||[];list.push(fn);this.listeners.set(name,list);}
 removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)||[]).filter(x=>x!==fn));}
 emit(name,event={}){for(const fn of [...(this.listeners.get(name)||[])])fn(event);}
 send(value){this.sent.push(JSON.parse(value));}
 close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
 open(){this.readyState=1;this.emit('open');}
 ready(){const id=this.sent.find(x=>x.endpoint==='$events').streamId;this.emit('message',{data:JSON.stringify({type:'item',streamId:id,value:{type:'ready',clientId:'fixture-client'}})});}
}
globalThis.WebSocket=FakeSocket;
const tick=ms=>new Promise(r=>setTimeout(r,ms));
async function start(client){
 const control=new AbortController(),frames=[];let opened=0;
 const stream=client.events.mux({},control.signal,()=>opened++);
 const done=(async()=>{for await(const f of stream)frames.push(f);})();
 await tick(0);return{socket:sockets.at(-1),control,frames,done,get opened(){return opened;}};
}
function client(){const c=new NodeApiClient('http://127.0.0.1:3080',40,{});c.ensureAuth=async()=>{c.cookie='fixture';};c.invalidateAuth=()=>{c.cookie=null;};return c;}
async function bounded(p){await Promise.race([p,tick(180).then(()=>{throw new Error('事件连接永久等待，未触发握手超时');})]);}

test('WebSocket 一直 CONNECTING 时有界失败并释放连接',async()=>{
 const c=client(),s=await start(c);
 try{await bounded(s.done);assert.equal(s.frames.at(-1).payload.error.code,'DSH_EVENT_HANDSHAKE_TIMEOUT');assert.equal(s.socket.readyState,3);}
 finally{s.control.abort();await s.done;}
});
test('socket open 不等于事件 ready，缺少 ready 必须超时',async()=>{
 const c=client(),s=await start(c);
 try{s.socket.open();assert.equal(s.opened,0);await bounded(s.done);assert.equal(c.eventStreamReady,false);}
 finally{s.control.abort();await s.done;}
});
test('真正 ready 后允许长时间无消息，取消会清理健康状态',async()=>{
 const c=client(),s=await start(c);
 try{s.socket.open();s.socket.ready();assert.equal(s.opened,1);assert.equal(c.eventStreamReady,true);await tick(75);assert.equal(s.socket.readyState,1);assert.equal(s.frames.length,0);}
 finally{s.control.abort();await s.done;}
 assert.equal(c.eventStreamReady,false);
});
test('旧连接的关闭不能使新连接失去 ready 或凭据',async()=>{
 const c=client(),a=await start(c);a.socket.open();a.socket.ready();const b=await start(c);
 try{b.socket.open();b.socket.ready();a.control.abort();await a.done;assert.equal(c.eventStreamReady,true);assert.equal(c.cookie,'fixture');}
 finally{a.control.abort();b.control.abort();await Promise.all([a.done,b.done]);}
});

test('旧连接迟到的 open 不能抢回新连接的订阅入口',async()=>{
 const c=client(),a=await start(c),b=await start(c);
 try{
  b.socket.open();b.socket.ready();a.socket.open();
  c.events.follow('fixture-session');
  assert.equal(b.socket.sent.some(x=>x.endpoint==='session/follow'&&x.payload?.args?.request?.address?.sessionId==='fixture-session'),true);
  assert.equal(a.socket.sent.length,0);
 }finally{a.control.abort();b.control.abort();await Promise.all([a.done,b.done]);}
});
