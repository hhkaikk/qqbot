#!/usr/bin/env python3
"""QQ网关有限恢复。只访问固定回环端口，不读取消息、不重启QQ或更换设备。"""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import signal
import tempfile
import threading
import time
import urllib.error
import urllib.request

APP_CONFIG=Path('/opt/qqbot/app/config.json')
WEB_CONFIG=Path('/opt/qqbot/gateway/config/webui.json')
STATE_DIR=Path('/var/lib/qqbot-gateway-guard')
PUBLIC_DIR=Path('/run/qqbot-gateway-guard')
EVENT_FILE=Path('/opt/qqbot/gateway/config/qqbot-offline-events.jsonl')
MESSAGES={
 'online':'QQ已在线', 'offline_grace':'QQ离线，等待网关自身恢复',
 'initializing':'QQ正在初始化，暂不重复登录', 'in_flight':'上一登录请求仍在保护窗口内',
 'accepted':'QQ已接受登录，等待实际在线确认', 'transport':'登录服务暂时不可达，已退避',
 'transient':'QQ报告网络异常，已退避', 'credential_missing':'登录身份失效，尚未配置自动密码凭据',
 'credential_invalid':'自动登录凭据格式无效，需要管理员处理',
 'credential_account_mismatch':'自动登录凭据不属于当前QQ，已停止',
 'account_mismatch':'实际账号与配置不一致，已停止自动登录',
 'account_changed':'恢复记录的账号与配置不一致，需要管理员确认',
 'invalid':'QQ拒绝账号或密码，已停止重试', 'expired':'QQ登录身份已失效',
 'captcha':'QQ要求验证码，请在登录页完成', 'device':'QQ要求手机确认设备，请在登录页完成',
 'unknown':'QQ拒绝登录，已停止自动重试', 'budget_exhausted':'自动登录达到本小时上限，等待窗口释放',
 'onebot_unavailable':'QQ核心已在线，但消息接口不可用，未重复登录',
 'login_stalled':'QQ登录已接受但长时间未就绪，需要管理员处理',
 'webui_verification_required':'网关管理页要求二次验证，需要管理员处理',
 'webui_auth':'网关管理鉴权失败，已停止自动登录',
 'state_error':'恢复状态文件异常，已停止自动登录', 'config_error':'恢复配置异常，已停止自动登录',
}
class GuardError(Exception):
    def __init__(self,code):self.code=code;super().__init__(MESSAGES.get(code,'恢复检查失败'))

def classify_login(body):
    if not isinstance(body,dict):raise GuardError('transport')
    data=body.get('data') if isinstance(body.get('data'),dict) else {}
    if data.get('needCaptcha'):return {'kind':'captcha'}
    if data.get('needNewDevice'):return {'kind':'device'}
    if body.get('code')==0:return {'kind':'accepted'}
    message=str(body.get('message',''))
    if any(x in message for x in ['验证码','captcha']):kind='captcha'
    elif any(x in message for x in ['新设备','异常设备','手机验证','设备验证']):kind='device'
    elif any(x in message for x in ['身份已失效','身份失效','登录态失效','重新登录','票据失效']):kind='expired'
    elif any(x in message for x in ['密码错误','密码不正确','账号或密码','帐号或密码','密码已修改','账号被冻结','帐号被冻结']):kind='invalid'
    elif any(x in message.lower() for x in ['网络','连接异常','超时','timeout','network','连接失败']):kind='transient'
    else:kind='unknown'
    return {'kind':kind}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

@contextlib.contextmanager
def request_deadline(seconds):
    # Linux生产服务在主线程运行：socket逐次超时不能阻止持续滴流，需整次请求的硬期限。
    enabled=hasattr(signal,'setitimer') and threading.current_thread() is threading.main_thread()
    if not enabled:
        yield;return
    previous_handler=signal.getsignal(signal.SIGALRM);previous_timer=signal.getitimer(signal.ITIMER_REAL)
    started=time.monotonic()
    def expired(*_):raise GuardError('transport')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,seconds)
    try:yield
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous_handler)
        if previous_timer[0]>0:signal.setitimer(signal.ITIMER_REAL,max(.000001,previous_timer[0]-(time.monotonic()-started)),previous_timer[1])

class GatewayClient:
    def __init__(self,config,web,request=None):
        self.expected_account=str(config.get('snowluma',{}).get('accountId',''))
        self.account=str(web.get('autoLoginAccount',''))
        if not re.fullmatch(r'[1-9][0-9]{4,11}',self.expected_account):raise GuardError('config_error')
        gateway=config.get('snowluma',{})
        if gateway.get('httpUrl','').rstrip('/')!='http://127.0.0.1:13000':raise GuardError('config_error')
        self.gateway_token=gateway.get('accessToken','');self.web_token=web.get('token','')
        if not isinstance(self.web_token,str) or not self.web_token:raise GuardError('config_error')
        self._credential=None
        self._request=request or self._http
        self._opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

    def _http(self,url,body,headers,timeout):
        req=urllib.request.Request(url,data=json.dumps(body).encode(),headers=headers,method='POST')
        try:
            with request_deadline(timeout),self._opener.open(req,timeout=timeout) as response:
                if response.status!=200:raise GuardError('transport')
                raw=response.read(65537)
                if len(raw)>65536:raise GuardError('transport')
                return json.loads(raw)
        except GuardError:raise
        except Exception:raise GuardError('transport') from None

    def _web(self,route,body=None,timeout=8):
        if self._credential is None:
            reply=self._request('http://127.0.0.1:16099/api/auth/login',
                {'hash':hashlib.sha256((self.web_token+'.napcat').encode()).hexdigest()},
                {'Content-Type':'application/json'},8)
            if not isinstance(reply,dict):raise GuardError('webui_auth')
            data=reply.get('data')
            if not isinstance(data,dict):raise GuardError('webui_auth')
            if data.get('require2FA'):raise GuardError('webui_verification_required')
            if reply.get('code')!=0 or not isinstance(data.get('Credential'),str) or not 1<=len(data['Credential'])<=8192:raise GuardError('webui_auth')
            self._credential=data['Credential']
        reply=self._request('http://127.0.0.1:16099/api/QQLogin/'+route,body or {},
            {'Content-Type':'application/json','Authorization':'Bearer '+self._credential},timeout)
        if not isinstance(reply,dict):raise GuardError('transport')
        return reply

    def gateway_status(self):
        try:
            def query(action):
                r=self._request('http://127.0.0.1:13000/'+action,{},
                    {'Content-Type':'application/json','Authorization':'Bearer '+self.gateway_token},3)
                if not isinstance(r,dict) or r.get('status')!='ok' or r.get('retcode')!=0:raise GuardError('transport')
                data=r.get('data')
                if not isinstance(data,dict):raise GuardError('transport')
                return data
            status=query('get_status');identity=query('get_login_info')
            return {'online':status.get('online'),'good':status.get('good'),'accountId':str(identity.get('user_id',''))}
        except GuardError:return None

    def login_status(self):
        r=self._web('CheckLoginStatus');data=r.get('data')
        if r.get('code')!=0 or not isinstance(data,dict):raise GuardError('transport')
        if type(data.get('isLogin')) is not bool or type(data.get('coreReady')) is not bool:raise GuardError('transport')
        if not isinstance(data.get('loginPhase'),str) or not data['loginPhase'].strip() or len(data['loginPhase'])>64:raise GuardError('transport')
        return {'phase':data.get('loginPhase'),'coreReady':data.get('coreReady') is True,
                'isLogin':data.get('isLogin') is True,'errorKind':classify_login({'code':-1,'message':data.get('loginError','')})['kind']}

    def quick_accounts(self):
        r=self._web('GetQuickLoginList');data=r.get('data')
        if r.get('code')!=0 or not isinstance(data,list):raise GuardError('transport')
        return [str(x) for x in data if isinstance(x,(str,int)) and not isinstance(x,bool)]
    def quick_login(self,account):return classify_login(self._web('SetQuickLogin',{'uin':account},95))
    def password_login(self,account,password_md5):
        if account!=self.expected_account or not re.fullmatch(r'[a-f0-9]{32}',password_md5):raise GuardError('credential_invalid')
        return classify_login(self._web('PasswordLogin',{'uin':account,'passwordMd5':password_md5},45))

class RecoveryGuard:
    def __init__(self,client,state,credential,save,now=time.time,sleep=time.sleep):
        self.client=client;self.state=state;self.credential=credential;self.save=save;self.now=now;self.sleep=sleep
        self.account=str(getattr(client,'expected_account',None) or state.get('accountId') or client.account)
        self.state.setdefault('version',1);self.state.setdefault('accountId',self.account)
        self.state.setdefault('attempts',[]);self.state.setdefault('requiresAction',False)
    def _set(self,phase,reason):
        self.state.update(phase=phase,reason=reason,checkedAt=self.now())
        self.save(self.state);return self.state
    def _block(self,reason):
        self.state['requiresAction']=True
        return self._set('needs_action',reason)
    def _online(self):
        self.state.update(requiresAction=False,firstOfflineAt=None,nextAttemptAt=0,inFlightUntil=0,failureCount=0,lastOnlineAt=self.now())
        self.state.pop('acceptedAt',None);self.state.pop('initializingAt',None)
        return self._set('online','online')
    def _matches(self,probe):
        return probe and probe.get('online') is True and probe.get('good') is True and str(probe.get('accountId'))==self.account
    def _count(self,kind):return sum(x['kind']==kind and self.now()-x['time']<3600 for x in self.state['attempts'])
    def _reserve(self,kind):
        cap=3 if kind=='quick' else 2
        if self._count(kind)>=cap:return False
        self.state['attempts'].append({'kind':kind,'time':self.now()})
        self.state.update(inFlightUntil=self.now()+180,nextAttemptAt=self.now()+180)
        self._set('recovering','expired' if kind=='password' else 'offline_grace')
        return True
    def _budget_wait(self,kind):
        times=[x['time']+3601 for x in self.state['attempts'] if x['kind']==kind and self.now()-x['time']<3600]
        self.state['nextAttemptAt']=max(self.now()+60,min(times) if times else self.now()+180)
        return self._set('cooldown','budget_exhausted')
    def _network(self,reason='transient'):
        count=min(self.state.get('failureCount',0)+1,3);self.state['failureCount']=count
        self.state['nextAttemptAt']=self.now()+[180,300,900][min(count-1,2)]
        return self._set('cooldown',reason)
    def _confirm(self):
        for i in range(5):
            self.sleep(1)
            probe=self.client.gateway_status()
            if self._matches(probe):return self._online()
            if probe and probe.get('accountId') and str(probe['accountId'])!=self.account:return self._block('account_mismatch')
        self.state['acceptedAt']=self.now()
        return self._set('waiting','accepted')
    def run(self):
        now=self.now()
        self.state['attempts']=[x for x in self.state['attempts'] if now-x['time']<3600][-20:]
        if str(self.state.get('accountId'))!=self.account:return self._block('account_changed')
        if str(self.client.account)!=self.account:return self._block('account_mismatch')
        probe=self.client.gateway_status()
        if probe and probe.get('accountId') and str(probe['accountId'])!=self.account:return self._block('account_mismatch')
        if self._matches(probe):return self._online()
        if self.state.get('requiresAction'):return self._set('needs_action',self.state.get('reason','unknown'))
        if self.state.get('firstOfflineAt') is None:self.state['firstOfflineAt']=now
        if self.state.get('inFlightUntil',0)>now:return self._set('waiting','in_flight')
        if self.state.get('nextAttemptAt',0)>now:return self._set('cooldown',self.state.get('reason','transient'))
        if now-self.state['firstOfflineAt']<180:return self._set('waiting','offline_grace')
        try:
            login=self.client.login_status()
            if login.get('isLogin') and login.get('coreReady'):return self._set('unavailable','onebot_unavailable')
            if login.get('errorKind') in ['captcha','device','invalid']:return self._block(login['errorKind'])
            if login.get('phase') in ['initializing','qrcode_scanned','generating_qrcode','reconnecting']:
                since=self.state.get('initializingAt') or now;self.state['initializingAt']=since
                if now-since>180:return self._block('login_stalled')
                return self._set('waiting','initializing')
            self.state.pop('initializingAt',None)
            if self.state.get('acceptedAt'):
                if now-self.state['acceptedAt']>180:return self._block('login_stalled')
                return self._set('waiting','accepted')
            accounts=self.client.quick_accounts()
            if self.account in accounts:
                if not self._reserve('quick'):return self._budget_wait('quick')
                result=self.client.quick_login(self.account)
                if result['kind']=='accepted':return self._confirm()
                if result['kind']=='transient':return self._network()
                if result['kind']!='expired':return self._block(result['kind'])
            password=self.credential()
            if not password:return self._block('credential_missing')
            if not re.fullmatch(r'[a-f0-9]{32}',password):return self._block('credential_invalid')
            if not self._reserve('password'):return self._budget_wait('password')
            result=self.client.password_login(self.account,password);del password
            if result['kind']=='accepted':return self._confirm()
            if result['kind']=='transient':return self._network()
            return self._block(result['kind'])
        except GuardError as error:
            if error.code=='transport':return self._network('transport')
            return self._block(error.code)
        except Exception:return self._block('unknown')

def atomic_json(path,value,mode=0o600):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,temp=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        os.fchmod(fd,mode) if hasattr(os,'fchmod') else None
        with os.fdopen(fd,'w',encoding='utf8') as file:
            json.dump(value,file,ensure_ascii=False);file.flush();os.fsync(file.fileno())
        os.replace(temp,path)
        if hasattr(os,'O_DIRECTORY'):
            folder=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(folder)
            finally:os.close(folder)
    finally:
        with contextlib.suppress(FileNotFoundError):os.unlink(temp)

def load_state(path):
    path=Path(path)
    if not path.exists():return {}
    try:
        if path.is_symlink() or path.stat().st_size>65536:raise ValueError()
        data=json.loads(path.read_text(encoding='utf8'))
        if not isinstance(data,dict) or data.get('version')!=1:raise ValueError()
        attempts=data.get('attempts',[])
        if not isinstance(attempts,list) or len(attempts)>100:raise ValueError()
        for row in attempts:
            if not isinstance(row,dict) or row.get('kind') not in ['quick','password'] or isinstance(row.get('time'),bool) or not isinstance(row.get('time'),(int,float)) or not math.isfinite(row['time']):raise ValueError()
        if 'failureCount' in data and (type(data['failureCount']) is not int or not 0<=data['failureCount']<=3):raise ValueError()
        if 'requiresAction' in data and type(data['requiresAction']) is not bool:raise ValueError()
        for key in ['firstOfflineAt','lastOnlineAt','inFlightUntil','nextAttemptAt','checkedAt','initializingAt','acceptedAt']:
            value=data.get(key)
            if value is not None and (isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0):raise ValueError()
        return data
    except Exception:raise GuardError('state_error') from None

def read_credential(account):
    directory=os.environ.get('CREDENTIALS_DIRECTORY')
    if not directory:return None
    try:
        path=Path(directory)/'qq-login'
        if not path.exists():return None
        if path.is_symlink() or path.stat().st_size>1024:raise GuardError('credential_invalid')
        data=json.loads(path.read_text(encoding='utf8'))
        if str(data.get('accountId'))!=account:raise GuardError('credential_account_mismatch')
        password=data.get('passwordMd5')
        if not isinstance(password,str) or not re.fullmatch(r'[a-f0-9]{32}',password):raise GuardError('credential_invalid')
        return password
    except GuardError:raise
    except Exception:raise GuardError('credential_invalid') from None

def public_status(state):
    return {key:state.get(key) for key in ['version','accountId','phase','reason','checkedAt','lastOnlineAt',
            'firstOfflineAt','nextAttemptAt','requiresAction','lastOfflineEvent']}

def read_offline_event(path=EVENT_FILE):
    try:
        if path.is_symlink() or path.stat().st_size>131072:return None
        for line in reversed(path.read_text(encoding='utf8').splitlines()[-200:]):
            row=json.loads(line)
            if row.get('kind') in ['KickedOffLine','SelfOffline'] and isinstance(row.get('time'),(int,float)):
                return {'kind':row['kind'],'time':row['time'],'reason':str(row.get('reason',''))[:300]}
    except Exception:pass
    return None

def main():
    parser=argparse.ArgumentParser(description='QQ网关有限恢复与脱敏状态')
    parser.add_argument('--check-credential',action='store_true')
    parser.add_argument('--reset-block',action='store_true')
    args=parser.parse_args()
    if not hasattr(os,'geteuid') or os.geteuid()!=0:raise GuardError('config_error')
    import fcntl
    STATE_DIR.mkdir(mode=0o700,parents=True,exist_ok=True)
    PUBLIC_DIR.mkdir(mode=0o755,parents=True,exist_ok=True)
    if STATE_DIR.is_symlink() or PUBLIC_DIR.is_symlink():raise GuardError('config_error')
    lock=open(STATE_DIR/'lock','a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:return 0
    state={};state_file=STATE_DIR/'state.json'
    try:
        config=json.loads(APP_CONFIG.read_text(encoding='utf8'));web=json.loads(WEB_CONFIG.read_text(encoding='utf8'))
        client=GatewayClient(config,web)
        if args.check_credential:
            value=read_credential(client.expected_account)
            print(json.dumps({'credentialAvailable':bool(value),'accountMatches':bool(value)}));return 0 if value else 1
        state=load_state(state_file)
        if args.reset_block:
            state.update(requiresAction=False,inFlightUntil=0,nextAttemptAt=0,acceptedAt=None,initializingAt=None)
        old=(state.get('phase'),state.get('reason'))
        offline=read_offline_event()
        if offline:state['lastOfflineEvent']=offline
        def save(value):
            atomic_json(state_file,value)
            atomic_json(PUBLIC_DIR/'status.json',public_status(value),0o644)
        result=RecoveryGuard(client,state,lambda:read_credential(client.expected_account),save).run()
        if old!=(result.get('phase'),result.get('reason')):
            summary={'time':time.time(),'phase':result['phase'],'reason':result['reason'],'message':MESSAGES.get(result['reason'],'需要管理员处理')}
            print(json.dumps(summary,ensure_ascii=False),flush=True)
        return 0
    except GuardError as error:
        state.update(version=1,phase='needs_action',requiresAction=True,reason=error.code,checkedAt=time.time())
        atomic_json(PUBLIC_DIR/'status.json',public_status(state),0o644)
        print(json.dumps({'phase':'needs_action','reason':error.code,'message':MESSAGES.get(error.code,'恢复检查失败')},ensure_ascii=False),flush=True)
        return 1

if __name__=='__main__':
    try:raise SystemExit(main())
    except GuardError as error:
        print(json.dumps({'phase':'needs_action','reason':error.code},ensure_ascii=False));raise SystemExit(1)
    except Exception:
        # Never print urllib errors, request objects, config or decrypted credentials.
        print(json.dumps({'phase':'needs_action','reason':'state_error'},ensure_ascii=False));raise SystemExit(1)
