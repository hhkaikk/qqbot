import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Mild stationary-noise reduction; no pitch shift, denoising model or extra API call.
// Resample before limiting, so resampling cannot recreate peaks above the ceiling.
const FILTER = 'highpass=f=70,lowpass=f=10000,afftdn=nr=8:nf=-45:tn=1,aresample=24000,alimiter=limit=0.707945784:level=0:attack=5:release=50:latency=1';
const failure = () => Object.assign(new Error('语音降噪处理失败，请检查服务器音频处理服务'), {code:'SPEECH_QUALITY_FAILED'});
const missingOk = error => {if(error.code!=='ENOENT')throw error;};

/** Wrap the same synthesizer for browser previews and QQ sends. Never replay a paid call. */
export function withSpeechQuality(synthesizer, {
  tempDir = os.tmpdir(), ffmpegPath = 'ffmpeg', timeoutMs = 8000,
  maxBytes = 3145728, spawnImpl = spawn,
} = {}) {
  if(typeof synthesizer?.synthesize!=='function'||typeof spawnImpl!=='function'
    ||![tempDir,ffmpegPath].every(x=>typeof x==='string'&&x.trim()&&!x.includes('\0'))
    ||![timeoutMs,maxBytes].every(x=>Number.isSafeInteger(x)&&x>0)
    ||timeoutMs>60000||maxBytes<44)throw failure();
  let active=false;
  return {async synthesize(text){
    if(active)throw Object.assign(new Error('语音合成繁忙'),{code:'SPEECH_BUSY'});
    active=true;let raw,dir,output;
    const cleanup=async()=>{
      if(output)await fs.unlink(output).catch(missingOk);
      if(dir)await fs.rmdir(dir).catch(missingOk);
    };
    try {
      // Keep provider errors intact: authentication/balance errors are actionable.
      raw=await synthesizer.synthesize(text);
      try {
        dir=await fs.mkdtemp(path.join(tempDir,'qqbot-speech-clean-'));
        await fs.chmod(dir,0o700);output=path.join(dir,'output.wav');
        await new Promise((resolve,reject)=>{
          let child,timer,settled=false,timedOut=false;
          const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(failure()):resolve();};
          try {
            child=spawnImpl(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-n','-threads','1','-filter_threads','1',
              '-i',raw.path,'-vn','-af',FILTER,'-ar','24000','-ac','1','-c:a','pcm_s16le','-fs',String(maxBytes+1),output],
              {shell:false,windowsHide:true,stdio:'ignore'});
            child.once('error',()=>finish(true));
            child.once('close',code=>{finish(code!==0);if(timedOut)cleanup().catch(()=>{});});
            timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL');}catch{}finish(true);},timeoutMs);
          }catch{finish(true);}
        });
        const stat=await fs.stat(output);
        if(!stat.isFile()||stat.size<44||stat.size>maxBytes)throw failure();
        const handle=await fs.open(output,'r');
        try {
          const head=Buffer.alloc(12);await handle.read(head,0,12,0);
          if(head.toString('ascii',0,4)!=='RIFF'||head.toString('ascii',8,12)!=='WAVE')throw failure();
        } finally {await handle.close();}
        await fs.chmod(output,0o600);
        return {path:output,cleanup};
      }catch{
        await cleanup().catch(()=>{});throw failure();
      }
    }finally{
      try{await raw?.cleanup();}catch{await cleanup().catch(()=>{});throw failure();}finally{active=false;}
    }
  }};
}
