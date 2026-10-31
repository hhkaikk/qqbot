import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createSpeechProviderAdmin} from '../src/speech-provider-admin.js';

test('真实配置路由：无鉴权和智能体被拒，密钥只写，试听成功后热切换',async()=>{
 let cloudCalls=0;const h=await bridgeHarness({files:{'public/speech-setup.html':'<!doctype html><title>音色设置</title>'},globals:{
  createSpeechProviderAdmin:opts=>createSpeechProviderAdmin({...opts,inspectAudio:async()=>({ok:true,duration:4,codec:'mp3',formatName:'mp3'}),
   createSynthesizer:()=>({synthesize:async()=>{cloudCalls++;const p=path.join(h.temp,'preview.mp3');fs.writeFileSync(p,'audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};}})}),
 }});
 const server=h.startConsoleServer();await new Promise(resolve=>server.once('listening',resolve));
 const call=async(route,body,headers={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 const admin={'x-console-token':'fixture-console-token'};
 try{
  const landing=await fetch(`http://127.0.0.1:${server.address().port}/speech-setup`);
  assert.equal(landing.status,401);assert.match(landing.headers.get('content-type'),/text\/html/);
  assert.match(await landing.text(),/localStorage.getItem/);
  assert.equal((await call('/api/voice/provider/key',{apiKey:'sk-fixture-only'})).status,401);
  for(const heads of [{'x-agent-token':'fixture-agent'},{'x-agent-call':'1'}]){
   assert.equal((await call('/api/voice/provider/key',{apiKey:'sk-fixture-only'},{...admin,...heads})).status,403);
   assert.equal((await call('/api/voice/provider',undefined,{...admin,...heads})).status,403);
  }
  assert.equal((await call('/api/voice/provider',undefined,admin)).data.keyConfigured,false);
  const saved=await call('/api/voice/provider/key',{apiKey:'sk-fixture-only'},admin);
  assert.equal(saved.status,200);assert.ok(!JSON.stringify(saved).includes('sk-fixture-only'));assert.equal(cloudCalls,0);
  const state=await call('/api/voice/provider',undefined,admin);assert.equal(state.data.keyConfigured,true);
  assert.ok(!JSON.stringify(state).includes('sk-fixture-only'));
  const activated=await call('/api/voice/provider/activate',{voice:'speech:test:x:y',text:'你好呀'},admin);
  assert.equal(activated.status,200);assert.equal(activated.data.provider,'siliconflow');assert.equal(cloudCalls,1);
  assert.equal(h.cfg.socialV2.voice.provider,'siliconflow');
  const disk=JSON.parse(fs.readFileSync(path.join(h.temp,'config.json')));
  assert.equal(disk.socialV2.voice.provider,'siliconflow');assert.ok(!JSON.stringify(disk).includes('sk-fixture-only'));
  assert.equal((await call('/api/voice/provider/restore',{},admin)).data.provider,'edge');
 }finally{await new Promise(resolve=>server.close(resolve));await h.close();}
});

test('实际QQ语音调用选中硅基适配，保留发送确认',async()=>{
 let sf=0,edge=0,quality=0;const h=await bridgeHarness({config:{snowluma:{gateway:'napcat',accountId:'999'},socialV2:{voice:{enabled:true,dynamicText:true,provider:'siliconflow',siliconflowVoice:'speech:test:x:y'},tools:{sendVoice:true}}},globals:{
  createSiliconFlowSpeechSynthesizer:options=>({synthesize:async()=>{sf++;assert.equal(options.voice,'speech:test:x:y');const p=path.join(h.temp,'sf.mp3');fs.writeFileSync(p,'audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};}}),
  createSpeechSynthesizer:()=>{edge++;throw new Error('不应调用Edge');},inspectAudio:async()=>({ok:true,size:5,duration:1,codec:'mp3',formatName:'mp3'}),
  withSpeechQuality:(raw,opts)=>({synthesize:async text=>{quality++;assert.ok(opts.tempDir);const original=await raw.synthesize(text);await original.cleanup();const p=path.join(h.temp,'clean.wav');fs.writeFileSync(p,'clean audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};}}),
 }});h.setMode('reserved2');h.setSelfIdentity('大肥鱼','999');
 try{const r=await h.sendSpeechForV2('private:123','你好呀');assert.equal(r.verification.confirmed,true);assert.equal(sf,1);assert.equal(edge,0);assert.equal(quality,1);
  const sent=h.calls.http.find(x=>x.url.endsWith('/send_private_msg'));assert.equal(sent.body.message[0].data.file,'base64://'+Buffer.from('clean audio').toString('base64'));}
 finally{await h.close();}
});

test('硅基合成失败也占付费尝试预算，后续调用在云请求前拒绝',async()=>{
 let generated=0;
 const h=await bridgeHarness({config:{socialV2:{voice:{enabled:true,dynamicText:true,provider:'siliconflow',siliconflowVoice:'speech:test:x:y',maxPerMinute:1,maxPerHour:1},tools:{sendVoice:true}}},globals:{
  createSiliconFlowSpeechSynthesizer:()=>({synthesize:async()=>{generated++;throw Object.assign(new Error('语音服务请求超时'),{code:'SPEECH_TIMEOUT'});}}),
 }});h.setMode('reserved2');h.setSelfIdentity('大肥鱼','999');
 try{
  await assert.rejects(h.sendSpeechForV2('private:123','你好呀'),/超时/);
  await assert.rejects(h.sendSpeechForV2('private:123','再试一次'),/频率|限流|预算|付费|超限/);
  assert.equal(generated,1,'失败后的第二次请求不应再次调用付费合成器');
 }finally{await h.close();}
});

test('旧配置接口不能改服务与音色，部分voice更新保留已生效字段',async()=>{
 const original={enabled:false,dynamicText:true,provider:'edge',siliconflowVoice:'speech:existing:x:y',maxChars:300};
 const h=await bridgeHarness({config:{socialV2:{voice:original}}});
 const server=h.startConsoleServer();await new Promise(resolve=>server.once('listening',resolve));
 const update=async voice=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/config`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token'},body:JSON.stringify({voice})});
  return{status:response.status,data:await response.json()};
 };
 try{
  for(const patch of [{provider:'siliconflow'},{siliconflowVoice:'speech:unvalidated:x:y'},{siliconflowSpeakingStyle:'chat'}]){
   const response=await update(patch);assert.ok(response.status>=400,`受管字段 ${JSON.stringify(patch)} 应拒绝，实际HTTP ${response.status}`);
   assert.equal(h.voiceCfg().provider,'edge');assert.equal(h.voiceCfg().siliconflowVoice,original.siliconflowVoice);assert.equal(h.voiceCfg().enabled,false);
  }
  const response=await update({maxChars:123});assert.equal(response.status,200);
  const runtime=h.voiceCfg();assert.equal(runtime.maxChars,123);assert.equal(runtime.enabled,false);assert.equal(runtime.provider,'edge');assert.equal(runtime.dynamicText,true);assert.equal(runtime.siliconflowVoice,original.siliconflowVoice);
  const disk=JSON.parse(fs.readFileSync(path.join(h.temp,'config.json'))).socialV2.voice;
  assert.equal(disk.maxChars,123);assert.equal(disk.enabled,false);assert.equal(disk.provider,'edge');assert.equal(disk.dynamicText,true);assert.equal(disk.siliconflowVoice,original.siliconflowVoice);
 }finally{await new Promise(resolve=>server.close(resolve));await h.close();}
});
