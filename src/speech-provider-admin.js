import fs from 'node:fs';
import path from 'node:path';
import {createSiliconFlowSpeechSynthesizer,uploadSiliconFlowVoice,validateSiliconFlowVoice,validateSiliconFlowSpeakingStyle} from './speech-siliconflow.js';

const failure = message => Object.assign(new Error(message), {code:'SPEECH_ADMIN'});

// 仅由已鉴权的控制台调用；不返回密钥、原始服务端错误或本地路径。
export function createSpeechProviderAdmin({root,getVoice,persistVoice,inspectAudio,
 createSynthesizer=createSiliconFlowSpeechSynthesizer,uploadVoice=uploadSiliconFlowVoice}) {
 const keyDir=path.join(root,'state','credentials');
 const apiKeyFile=path.join(keyDir,'siliconflow-api-key');
 const refDir=path.join(root,'state','speech-reference');
 const tempDir=path.join(root,'state','speech-temp');
 const choiceFile=path.join(root,'state','speech-provider-choice.json');
 let busy=false;const paidCalls=[];
 const privateDir=dir=>{fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink())throw failure('语音私有目录无效');fs.chmodSync(dir,0o700);};
 const atomic=(target,data)=>{const tmp=target+'.new';fs.writeFileSync(tmp,data,{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,target);};
 const status=()=>{
  let candidateVoice='';try{candidateVoice=JSON.parse(fs.readFileSync(choiceFile,'utf8')).voice||'';}catch{}
  return {ok:true,provider:getVoice().provider||'edge',keyConfigured:fs.existsSync(apiKeyFile),voice:getVoice().siliconflowVoice||'',speakingStyle:getVoice().siliconflowSpeakingStyle||'default',candidateVoice};
 };
 async function exclusive(fn,paid=false){
  if(busy)throw failure('语音配置正在处理，请勿重复提交');
  const now=Date.now();while(paidCalls.length&&paidCalls[0]<now-60000)paidCalls.shift();
  if(paid&&paidCalls.length>=3)throw failure('语音试听/创建每分钟最多3次，请稍后再试');
  busy=true;if(paid)paidCalls.push(now);
  try{return await fn();}finally{busy=false;}
 }
 function needKey(){if(!fs.existsSync(apiKeyFile))throw failure('请先保存硅基流动 API Key');}
 return {
  status,
  saveKey:key=>exclusive(async()=>{
   if(typeof key!=='string'||!/^[\x21-\x7e]{8,512}$/.test(key))throw failure('API Key 格式无效，请勿包含空格或换行');
   privateDir(keyDir);atomic(apiKeyFile,key);return status();
  }),
  createVoice:body=>exclusive(async()=>{
   needKey();
   if(typeof body.text!=='string'||!body.text.trim()||body.text.length>2000)throw failure('请填写参考音频的准确台词（最多2000字）');
   const match=/^data:audio\/(?:mpeg|mp3);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(body.audio||''));
   if(!match||match[1].length>700000||match[1].length%4)throw failure('参考音频须为不超过512KB的MP3');
   const audio=Buffer.from(match[1],'base64');if(!audio.length||audio.length>512*1024||audio.toString('base64')!==match[1])throw failure('参考音频格式或大小无效');
   privateDir(refDir);const dir=fs.mkdtempSync(path.join(refDir,'clip-'));fs.chmodSync(dir,0o700);
   const file=path.join(dir,'reference.mp3');
   try{
    fs.writeFileSync(file,audio,{mode:0o600});const probe=await inspectAudio(file,{maxBytes:512*1024,maxSeconds:30});
    if(!probe.ok||probe.codec!=='mp3'||!String(probe.formatName).split(',').includes('mp3')||!Number.isFinite(probe.duration)||probe.duration<3||probe.duration>30)throw failure('参考音频须为3–30秒的有效MP3，推荐8–10秒清晰独白');
    const voice=await uploadVoice({apiKeyFile,audioPath:file,text:body.text.trim(),customName:`dafeiyu-${Date.now()}`});
    validateSiliconFlowVoice(voice);if(!voice.startsWith('speech:'))throw failure('自定义音色创建结果无效');
    atomic(choiceFile,JSON.stringify({voice}));return{ok:true,voice};
   }finally{try{fs.unlinkSync(file);}catch{}try{fs.rmdirSync(dir);}catch{}}
  },true),
  activate:body=>exclusive(async()=>{
   needKey();validateSiliconFlowVoice(body.voice);
   const speakingStyle=validateSiliconFlowSpeakingStyle(body.speakingStyle??getVoice().siliconflowSpeakingStyle??'default');
   if(typeof body.text!=='string'||!body.text.trim()||body.text.length>80)throw failure('试听文字须为1–80字');
   privateDir(tempDir);let generated;
   try{
    generated=await createSynthesizer({apiKeyFile,voice:body.voice,tempDir,maxChars:80,speakingStyle}).synthesize(body.text.trim());
    const probe=await inspectAudio(generated.path,{maxBytes:3*1024*1024,maxSeconds:30});
    const formats=String(probe.formatName).split(',');
    const mp3=probe.codec==='mp3'&&formats.includes('mp3')&&path.extname(generated.path)==='.mp3';
    const wav=probe.codec==='pcm_s16le'&&formats.includes('wav')&&path.extname(generated.path)==='.wav';
    if(!probe.ok||(!mp3&&!wav)||!Number.isFinite(probe.duration)||probe.duration<=0||probe.duration>30)throw failure('试听音频校验失败，未切换服务');
    const bytes=fs.readFileSync(generated.path);if(!bytes.length||bytes.length>3*1024*1024)throw failure('试听音频大小无效，未切换服务');
    await persistVoice({provider:'siliconflow',siliconflowVoice:body.voice,siliconflowSpeakingStyle:speakingStyle});
    return {...status(),audio:`data:audio/${wav?'wav':'mpeg'};base64,${bytes.toString('base64')}`};
   }finally{try{await generated?.cleanup();}catch{}}
  },true),
  restore:()=>exclusive(async()=>{await persistVoice({provider:'edge'});return status();}),
 };
}
