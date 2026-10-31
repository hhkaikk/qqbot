import fs from 'node:fs';

const PHASES=new Set(['online','waiting','recovering','cooldown','needs_action','unavailable']);
const MESSAGES={
 online:'QQ已确认在线，自动恢复服务已就绪',offline_grace:'QQ离线，等待网关自身恢复',
 initializing:'QQ正在初始化，暂不重复登录',in_flight:'上一登录请求仍在保护窗口内',
 accepted:'登录已接受，等待QQ实际在线',transport:'网关暂时不可达，已延后重试',
 transient:'QQ网络连接异常，已延后重试',expired:'QQ登录身份失效，正在尝试受限回退',
 credential_missing:'身份失效，尚未配置自动登录凭据',credential_invalid:'自动登录凭据异常，请管理员检查',
 credential_account_mismatch:'自动登录凭据不属于当前QQ，已停止',account_mismatch:'QQ账号不符，已停止自动登录',
 account_changed:'QQ账号配置已改变，需要管理员确认',invalid:'QQ拒绝账号或密码，已停止重试',
 captcha:'QQ要求验证码，请打开QQ登录页完成',device:'QQ要求手机确认设备，请打开QQ登录页完成',
 unknown:'QQ拒绝登录，需要管理员处理',budget_exhausted:'自动登录达到本小时上限，等待窗口释放',
 onebot_unavailable:'QQ核心已在线，但消息接口不可用',login_stalled:'QQ登录长时间未就绪，需要管理员处理',
 webui_verification_required:'网关管理页要求二次验证',webui_auth:'网关管理鉴权失败',
 state_error:'恢复记录异常，已停止自动登录',config_error:'恢复配置异常，已停止自动登录',
};
const unavailable=()=>({phase:'unknown',reason:'status_unavailable',message:'自动恢复状态不可用或已过期',stale:true,requiresAction:false});
export function readGatewayRecoveryStatus({file='/run/qqbot-gateway-guard/status.json',now=Date.now()}={}){
 let fd;
 try{
  if(!fs.existsSync(file))return null;
  if(fs.lstatSync(file).isSymbolicLink())return unavailable();
  fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  const info=fs.fstatSync(fd);if(!info.isFile()||info.size>16384)return unavailable();
  const buffer=Buffer.alloc(16385);const length=fs.readSync(fd,buffer,0,buffer.length,0);
  if(length>16384||length<info.size)return unavailable();
  const value=JSON.parse(buffer.subarray(0,length).toString('utf8'));
  const checkedAtMs=value?.checkedAt*1000;
  if(value?.version!==1||!PHASES.has(value.phase)||!Number.isFinite(checkedAtMs)||checkedAtMs<=0||now-checkedAtMs>180000||checkedAtMs>now+30000)return unavailable();
  const reason=Object.hasOwn(MESSAGES,value.reason)?value.reason:'unknown';
  const result={phase:value.phase,reason,message:MESSAGES[reason],checkedAtMs,stale:false,requiresAction:value.requiresAction===true};
  for(const [source,target] of [['lastOnlineAt','lastOnlineAtMs'],['nextAttemptAt','nextAttemptAtMs']]){
   if(typeof value[source]==='number'&&Number.isFinite(value[source])&&value[source]>0)result[target]=value[source]*1000;
  }
  return result;
 }catch{return unavailable();}
 finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
