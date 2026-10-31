// Real DSP regression, entirely local. No QQ messages, API requests or production files.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {withSpeechQuality} from '../src/speech-quality.js';
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
const available=spawnSync(ffmpeg,['-version'],{windowsHide:true,timeout:5000}).status===0;
const rms=(buffer,start,end)=>{
 let sum=0,n=0;
 for(let i=Math.round(start*24000);i<Math.round(end*24000);i++){const x=buffer.readFloatLE(i*4);sum+=x*x;n++;}
 return Math.sqrt(sum/n);
};
test('真实ffmpeg：稳态沙沙声降低至少3dB，语音频带保持，输出无削波',{skip:!available},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'speech-quality-dsp-'));
 const raw=path.join(root,'noisy.wav');let cleaned;
 const command=args=>{
  const p=spawnSync(ffmpeg,['-v','error',...args],{windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});
  assert.equal(p.status,0,p.stderr?.toString());return p.stdout;
 };
 try {
  command(['-f','lavfi','-i','aevalsrc=if(between(t\\,1\\,2)+between(t\\,3\\,4)\\,0.12*sin(2*PI*330*t)\\,0)+0.004*(random(0)*2-1):s=32000:d=5','-ac','1','-c:a','pcm_f32le',raw]);
  const before=command(['-i',raw,'-ar','24000','-ac','1','-f','f32le','-']);
  cleaned=await withSpeechQuality({synthesize:async()=>({path:raw,cleanup:async()=>{}})},{tempDir:root,ffmpegPath:ffmpeg}).synthesize('fixture');
  const after=command(['-i',cleaned.path,'-f','f32le','-']);
  const reduction=20*Math.log10(rms(before,0.4,0.8)/rms(after,0.4,0.8));
  const voiceDelta=20*Math.log10(rms(after,1.3,1.7)/rms(before,1.3,1.7));
  let peak=0;for(let i=0;i<after.length;i+=4)peak=Math.max(peak,Math.abs(after.readFloatLE(i)));
  assert.ok(reduction>=3,`实测降噪仅${reduction.toFixed(2)}dB`);
  assert.ok(Math.abs(voiceDelta)<2,`语音频带变化${voiceDelta.toFixed(2)}dB`);
  assert.ok(peak<=0.708,`峰值超限${peak}`);assert.ok(Math.abs(after.length/4/24000-5)<0.05);
  console.log(`DSP实测：底噪降低${reduction.toFixed(2)}dB，语音频带变化${voiceDelta.toFixed(2)}dB`);
 }finally{await cleaned?.cleanup();await fs.rm(root,{recursive:true,force:true});}
});
