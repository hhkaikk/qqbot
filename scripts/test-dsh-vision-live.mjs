// 少量真实模型验收：两张人工生成的清晰测试图，不读聊天、不发QQ消息；会产生少量API用量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json')));
const api=new NodeApiClient(cfg.dsh.baseUrl,10000,{});
const controller=new AbortController();
const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-vision-live-'));
let sid, timer, openTimer, pump;
function image(label,shape) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" fill="white"/><text x="50" y="100" font-family="sans-serif" font-size="55" fill="black">${label}</text>${shape}</svg>`;
  return new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng();
}
try {
  sid=unwrap(await api.sessions.create({cwd:home,agentPreset:'qq-chat'})).sessionId;
  unwrap(await api.sessions.selectModel({sessionId:sid,provider:cfg.dsh.provider,model:cfg.dsh.model,reasoningEffort:cfg.dsh.reasoningEffort||'high'}));
  let opened;
  const ready=new Promise((resolve,reject)=>{opened=resolve;openTimer=setTimeout(()=>reject(new Error('事件源未就绪')),12000);});
  const stream=api.events.mux({},controller.signal,()=>{clearTimeout(openTimer);opened();});
  const collector=createTurnCollector();let resolveTurn,rejectTurn;
  const turn=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;timer=setTimeout(()=>reject(new Error('识图回合超时')),60000);});turn.catch(()=>{});
  pump=(async()=>{for await(const {payload} of stream){if(payload.type==='session/event'&&payload.sessionId===sid){const ended=collector.push(payload.event);if(ended){resolveTurn(ended);return;}}}rejectTurn(new Error('事件流提前结束'));})().catch(rejectTurn);
  await ready;stream.follow(sid);
  const one=image('ORDER 4837','<rect x="100" y="180" width="180" height="180" fill="#1565ff"/><circle cx="580" cy="270" r="90" fill="#ec243c"/>');
  const two=image('CODE 8265','<polygon points="450,170 320,390 580,390" fill="#20a358"/>');
  const started=performance.now();
  unwrap(await api.sessions.prompt({sessionId:sid,mode:'queue',content:[
    {type:'text',text:'这是离线图片识别验收，不调用任何工具，不发QQ消息。按图1、图2分别读取顶部文字和数字，识别全部几何图形的形状和颜色，不要混淆两张图。只输出JSON对象：images数组按原图顺序，每项包含index、text、shapes数组；每个图形包含shape（square/circle/triangle）和color（blue/red/green）。'},
    {type:'image',mediaType:'image/png',data:one.toString('base64'),name:'first.png'},
    {type:'image',mediaType:'image/png',data:two.toString('base64'),name:'second.png'}
  ]}));
  const ended=await turn;const answer=ended.text;
  assert.equal(ended.reason.kind,'completed');
  const parsed=JSON.parse(answer.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  assert.equal(parsed.images.length,2);
  assert.equal(parsed.images[0].index,1);assert.match(parsed.images[0].text,/ORDER\s*4837/);
  assert.equal(parsed.images[1].index,2);assert.match(parsed.images[1].text,/CODE\s*8265/);
  assert.deepEqual(parsed.images[0].shapes.map(x=>`${x.color}:${x.shape}`).sort(),['blue:square','red:circle']);
  assert.deepEqual(parsed.images[1].shapes.map(x=>`${x.color}:${x.shape}`),['green:triangle']);
  console.log(JSON.stringify({ok:true,model:cfg.dsh.model,elapsedMs:Math.round(performance.now()-started),answer}));
} finally {
  clearTimeout(timer);clearTimeout(openTimer);controller.abort();
  await pump;
  if(sid){try{await api.stopSessionWork(sid);}finally{unwrap(await api.workspace.archiveSession({sessionId:sid}));}}
  assert.equal(path.dirname(home),os.tmpdir());
  assert.ok(path.basename(home).startsWith('qq-vision-live-'));
  fs.rmSync(home,{recursive:true,force:true});
}
