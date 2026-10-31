// 仅追加离线事件原因；异常不改变原有QQ恢复回调，不读取聊天或登录凭据。
export function recordOffline({fs,path,directory,accountId,reason,time=Date.now()/1000}){
 let fd;
 try{
  const text=String(reason??'QQ未提供离线原因')
   .replace(/https?:\/\/[^\s"'<>]+/gi,'[链接已隐藏]')
   .replace(/\bsk-[A-Za-z0-9_-]+/g,'[凭据已隐藏]')
   .replace(/\bBearer\s+[^\s]+/gi,'[凭据已隐藏]')
   .replace(/\b(?:token|password|passwd|secret|session[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[凭据已隐藏]')
   .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').slice(0,500);
  const file=path.join(directory,'qqbot-offline-events.jsonl');
  if(fs.existsSync(file)){
   const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())return;
   if(info.size>65536)fs.renameSync(file,file+'.1');
  }
  const row={version:1,time,accountId:String(accountId||''),kind:text.includes('[KickedOffLine]')?'KickedOffLine':text.includes('[SelfOffline]')?'SelfOffline':'UnknownOffline',reason:text};
  fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0),0o600);
  fs.fchmodSync(fd,0o600);fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);
 }catch{/* 诊断记录失败也不能中断原有恢复。 */}
 finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
