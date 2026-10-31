import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSpeechProviderAdmin} from '../src/speech-provider-admin.js';
function fixture(overrides={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'speech-admin-'));let current={provider:'edge'};const calls=[];
 const admin=createSpeechProviderAdmin({root,getVoice:()=>current,persistVoice:async patch=>{current={...current,...patch};calls.push(patch);},
 inspectAudio:async()=>({ok:true,duration:8,codec:'mp3',formatName:'mp3'}),uploadVoice:async()=> 'speech:dafeiyu:test:id',
 createSynthesizer:()=>({synthesize:async()=>{const p=path.join(root,'preview.mp3');fs.writeFileSync(p,'audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};}}),...overrides});
 return {root,admin,calls,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('密钥只写状态，不回显，不自动切换或发起付费请求',async()=>{
 const h=fixture();try{
  const r=await h.admin.saveKey('sk-fixture-secret-key-123');assert.equal(r.keyConfigured,true);
  assert.ok(!JSON.stringify(r).includes('sk-'));assert.equal(h.calls.length,0);
  await assert.rejects(h.admin.saveKey('bad\r\nkey'));
 }finally{h.close();}
});
test('参考音频上传先验证大小、音频时长和台词，失败不调用云端',async()=>{
 let called=0;const h=fixture({uploadVoice:async()=>{called++;return 'speech:dafeiyu:test:id';}});
 try{await h.admin.saveKey('sk-fixture-secret-key-123');
  await assert.rejects(h.admin.createVoice({audio:'data:audio/mpeg;base64,YQ==',text:''}));
  await assert.rejects(h.admin.createVoice({audio:'not-base64',text:'你好'}));
  assert.equal(called,0);
  const r=await h.admin.createVoice({audio:'data:audio/mpeg;base64,YXVkaW8=',text:'你好'});
  assert.equal(r.voice,'speech:dafeiyu:test:id');assert.equal(called,1);assert.equal(h.calls.length,0);
  assert.equal(fs.readdirSync(path.join(h.root,'state','speech-reference')).length,0);
 }finally{h.close();}
});
test('只有试听音频有效时才持久切换，试听返回后清理文件',async()=>{
 const h=fixture();try{await h.admin.saveKey('sk-fixture-secret-key-123');
  const r=await h.admin.activate({voice:'speech:dafeiyu:test:id',text:'你好呀'});
  assert.equal(h.calls[0].provider,'siliconflow');assert.match(r.audio,/^data:audio\/mpeg;base64,/);
  assert.ok(!fs.existsSync(path.join(h.root,'preview.mp3')));
 }finally{h.close();}
});
test('无密钥、无效voice或试听失败不能切换',async()=>{
 const h=fixture({createSynthesizer:()=>({synthesize:async()=>{throw new Error('SPEECH_TIMEOUT');}})});
 try{
  await assert.rejects(h.admin.activate({voice:'speech:x:y:z',text:'你好'}));
  await h.admin.saveKey('sk-fixture-secret-key-123');
  await assert.rejects(h.admin.activate({voice:'https://bad',text:'你好'}));
  await assert.rejects(h.admin.activate({voice:'speech:x:y:z',text:'你好'}));assert.equal(h.calls.length,0);
 }finally{h.close();}
});
test('恢复Edge不需要密钥、不调用云端',async()=>{
 const h=fixture();try{await h.admin.restore();assert.deepEqual(h.calls,[{provider:'edge'}]);}finally{h.close();}
});
test('日常说话模式在试听成功后持久保存，未知模式在付费调用前拒绝',async()=>{
 let generated=0;
 const h=fixture({createSynthesizer:options=>({synthesize:async()=>{
  generated++;assert.equal(options.speakingStyle,'chat');const p=path.join(h.root,'chat.mp3');fs.writeFileSync(p,'audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};
 }})});
 try{await h.admin.saveKey('sk-fixture-secret-key-123');
  await assert.rejects(h.admin.activate({voice:'speech:dafeiyu:test:id',text:'你好呀',speakingStyle:'bad'}));assert.equal(generated,0);
  const r=await h.admin.activate({voice:'speech:dafeiyu:test:id',text:'你好呀',speakingStyle:'chat'});
  assert.equal(r.speakingStyle,'chat');assert.equal(h.calls[0].siliconflowSpeakingStyle,'chat');assert.equal(generated,1);
 }finally{h.close();}
});

test('降噪后的PCM WAV试听使用真实格式返回并清理',async()=>{
 const h=fixture({inspectAudio:async()=>({ok:true,duration:4,codec:'pcm_s16le',formatName:'wav'}),
  createSynthesizer:()=>({synthesize:async()=>{const p=path.join(h.root,'preview.wav');fs.writeFileSync(p,'clean audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};}})});
 try{await h.admin.saveKey('sk-fixture-secret-key-123');
  const r=await h.admin.activate({voice:'speech:dafeiyu:test:id',text:'你好呀'});
  assert.match(r.audio,/^data:audio\/wav;base64,/);assert.equal(h.calls.length,1);
  assert.ok(!fs.existsSync(path.join(h.root,'preview.wav')));
 }finally{h.close();}
});

test('伪装MP3的WAV、无音轨或容器编码不匹配时不上传也不启用',async()=>{
 for(const media of [
  {codec:'pcm_s16le',formatName:'wav'},
  {codec:'',formatName:'mov,mp4,m4a,3gp,3g2,mj2'},
  {codec:'mp3',formatName:'wav'},
  {codec:'pcm_s16le',formatName:'mp3'},
 ]){
  let uploads=0,syntheses=0;
  const h=fixture({inspectAudio:async()=>({ok:true,duration:8,...media}),
   uploadVoice:async()=>{uploads++;return 'speech:dafeiyu:test:id';},
   createSynthesizer:()=>({synthesize:async()=>{syntheses++;const p=path.join(h.root,'preview.mp3');fs.writeFileSync(p,'audio');return{path:p,cleanup:async()=>fs.unlinkSync(p)};}}),
  });
  try{
   await h.admin.saveKey('sk-fixture-secret-key-123');
   await assert.rejects(h.admin.createVoice({audio:'data:audio/mpeg;base64,YXVkaW8=',text:'你好'}),undefined,JSON.stringify(media));
   assert.equal(uploads,0,JSON.stringify(media));
   assert.equal(fs.readdirSync(path.join(h.root,'state','speech-reference')).length,0);
   await assert.rejects(h.admin.activate({voice:'speech:dafeiyu:test:id',text:'你好呀'}),undefined,JSON.stringify(media));
   assert.equal(syntheses,1);assert.equal(h.calls.length,0,JSON.stringify(media));
   assert.ok(!fs.existsSync(path.join(h.root,'preview.mp3')));
   assert.equal(h.admin.status().provider,'edge');
  }finally{h.close();}
 }
});
