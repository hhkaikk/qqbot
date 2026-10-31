import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { withSpeechQuality } from '../src/speech-quality.js';

const wav = () => {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40,4); b.write('WAVE',8);
  b.write('fmt ',12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(24000,24); b.writeUInt32LE(48000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34);
  b.write('data',36); b.writeUInt32LE(4,40); return b;
};
async function fixture(spawnImpl, options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'speech-quality-test-'));
  const raw=path.join(root,'raw.mp3'); await fs.writeFile(raw,'raw');
  let calls=0,cleaned=0;
  const synth=withSpeechQuality({synthesize:async()=>{calls++;return {path:raw,cleanup:async()=>{cleaned++;await fs.unlink(raw);}};}},
    {tempDir:root,spawnImpl,...options});
  return {root,raw,synth,get calls(){return calls;},get cleaned(){return cleaned;},close:()=>fs.rm(root,{recursive:true,force:true})};
}

test('合成后固定轻度降噪、24k单声道无损输出，原文件和产物分别清理',async()=>{
  let argsSeen;
  const h=await fixture((_exe,args,opts)=>{
    argsSeen=args;assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);
    const child=new EventEmitter();child.kill=()=>true;
    setImmediate(async()=>{await fs.writeFile(args.at(-1),wav());child.emit('close',0);});return child;
  });
  try {
    const result=await h.synth.synthesize('你好');
    assert.equal(h.calls,1);assert.equal(h.cleaned,1);assert.equal(path.extname(result.path),'.wav');
    assert.match(argsSeen[argsSeen.indexOf('-af')+1],/afftdn=nr=8/);
    assert.match(argsSeen[argsSeen.indexOf('-af')+1],/aresample=24000.*alimiter=.*level=0/);
    assert.ok(argsSeen.includes('pcm_s16le'));assert.ok(argsSeen.includes('-nostdin'));
    assert.equal((await fs.readFile(result.path)).toString('ascii',8,12),'WAVE');
    await result.cleanup();await result.cleanup();assert.deepEqual(await fs.readdir(h.root),[]);
  } finally {await h.close();}
});

for(const kind of ['failed','invalid','oversize','timeout'])test(`降噪${kind}时不返回原始噪音，不重试且清理临时文件`,async()=>{
  let killed=false;
  const h=await fixture((_exe,args)=>{
    const child=new EventEmitter();child.kill=()=>{killed=true;return true;};
    if(kind!=='timeout')setImmediate(async()=>{
      await fs.writeFile(args.at(-1),kind==='invalid'?Buffer.from('bad'):kind==='oversize'?Buffer.alloc(513):wav());
      child.emit('close',kind==='failed'?1:0);
    });return child;
  },{timeoutMs:80,maxBytes:512});
  try {
    await assert.rejects(h.synth.synthesize('你好'),e=>e.code==='SPEECH_QUALITY_FAILED');
    assert.equal(h.calls,1);assert.equal(h.cleaned,1);assert.equal(killed,kind==='timeout');
    assert.deepEqual(await fs.readdir(h.root),[]);
  } finally {await h.close();}
});

test('服务端余额/鉴权错误保留，不启动ffmpeg、不重试',async()=>{
  const err=Object.assign(new Error('余额不足'),{code:'SPEECH_PAYMENT_REQUIRED'});let calls=0;
  const synth=withSpeechQuality({synthesize:async()=>{calls++;throw err;}},{spawnImpl:()=>assert.fail('不应启动')});
  await assert.rejects(synth.synthesize('你好'),e=>e===err);assert.equal(calls,1);
});
