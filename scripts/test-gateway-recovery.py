"""真实恢复策略的隔离回归；没有QQ、服务器或真实凭据访问。"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
import threading
import http.server
import time
from unittest import mock

SOURCE=Path(__file__).resolve().parents[1]/'deploy'/'gateway-recovery.py'
spec=importlib.util.spec_from_file_location('gateway_recovery',SOURCE)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Guard=module.RecoveryGuard
ACCOUNT='900000008'
NOW=100000
EXPIRED_NOTICE='[KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。'

class Peer:
    account=ACCOUNT
    def __init__(self,quick='expired',password='accepted',online=False):
        self.online=online;self.quick_result=quick;self.password_result=password
        self.calls=[];self.phase='waiting_qrcode';self.accounts=[ACCOUNT]
        self.after_accept=True;self.before_mutation=lambda kind:None
    def gateway_status(self):
        return {'online':True,'good':True,'accountId':ACCOUNT} if self.online else None
    def login_status(self):return {'phase':self.phase,'coreReady':False,'isLogin':False}
    def quick_accounts(self):return self.accounts
    def quick_login(self,account):
        self.before_mutation('quick');self.calls.append(('quick',account))
        if self.quick_result=='accepted' and self.after_accept:self.online=True
        return {'kind':self.quick_result}
    def password_login(self,account,password):
        self.before_mutation('password');self.calls.append(('password',account))
        if self.password_result=='accepted' and self.after_accept:self.online=True
        return {'kind':self.password_result}

class RecoveryTests(unittest.TestCase):
    def run_guard(self,peer=None,state=None,credential=True,now=NOW):
        peer=peer or Peer();state=state if state is not None else {'version':1,'accountId':ACCOUNT,'firstOfflineAt':NOW-240}
        saved=[];reads=[]
        def save(value):saved.append(copy.deepcopy(value))
        def secret():
            reads.append(True)
            return 'a'*32 if credential else None
        result=Guard(peer,state,secret,save,now=lambda:now,sleep=lambda _:None).run()
        return result,peer,saved,reads

    def test_identity_expired_falls_back_once_and_requires_actual_online(self):
        state,peer,saved,reads=self.run_guard()
        self.assertEqual(peer.calls,[('quick',ACCOUNT),('password',ACCOUNT)])
        self.assertEqual(state['phase'],'online');self.assertTrue(reads)
        self.assertEqual([x['kind'] for x in state['attempts']],['quick','password'])

    def test_healthy_never_reads_secret_or_logs_in(self):
        state,peer,saved,reads=self.run_guard(Peer(online=True))
        self.assertEqual(state['phase'],'online');self.assertEqual(peer.calls,[]);self.assertEqual(reads,[])

    def test_quick_success_does_not_read_password(self):
        state,peer,saved,reads=self.run_guard(Peer(quick='accepted'))
        self.assertEqual(peer.calls,[('quick',ACCOUNT)]);self.assertEqual(state['phase'],'online');self.assertEqual(reads,[])

    def test_confirmed_login_expiry_skips_unusable_quick_ticket(self):
        state={'version':1,'accountId':ACCOUNT,'lastOnlineAt':NOW-300,'firstOfflineAt':NOW-240,
               'lastOfflineEvent':{'kind':'KickedOffLine','accountId':ACCOUNT,'time':NOW-250,'reason':EXPIRED_NOTICE}}
        peer=Peer(quick='unknown')
        result,peer,_,_=self.run_guard(peer,state)
        self.assertEqual(result['phase'],'online')
        self.assertEqual(peer.calls,[('password',ACCOUNT)])

    def test_confirmed_expiry_still_respects_password_budget(self):
        state={'accountId':ACCOUNT,'lastOnlineAt':NOW-300,'firstOfflineAt':NOW-240,
               'lastOfflineEvent':{'kind':'KickedOffLine','accountId':ACCOUNT,'time':NOW-250,'reason':EXPIRED_NOTICE},
               'attempts':[{'kind':'password','time':NOW-500},{'kind':'password','time':NOW-400}]}
        result,peer,_,_=self.run_guard(state=state)
        self.assertEqual(result['reason'],'budget_exhausted')
        self.assertEqual(peer.calls,[])

    def test_expiry_notice_cannot_replace_account_match_freshness_or_verification(self):
        base={'kind':'KickedOffLine','accountId':ACCOUNT,'time':NOW-250,'reason':EXPIRED_NOTICE}
        for event in [
            {**base,'accountId':'12345'}, {**base,'time':NOW-500},
            {**base,'time':NOW+1}, {**base,'kind':'SelfOffline'},
            {**base,'reason':'QQ下线，请重新登录'}, {**base,'reason':EXPIRED_NOTICE+'账号被冻结'},
        ]:
            with self.subTest(event=event):
                state={'accountId':ACCOUNT,'lastOnlineAt':NOW-300,'firstOfflineAt':NOW-240,'lastOfflineEvent':event}
                result,peer,_,_=self.run_guard(Peer(quick='unknown'),state)
                self.assertEqual(result['reason'],'unknown')
                self.assertEqual(peer.calls,[('quick',ACCOUNT)])
        for kind in ['device','captcha','invalid']:
            state={'accountId':ACCOUNT,'lastOnlineAt':NOW-300,'firstOfflineAt':NOW-240,'lastOfflineEvent':base}
            peer=Peer()
            peer.login_status=lambda:{'phase':'waiting_qrcode','coreReady':False,'isLogin':False,'errorKind':kind}
            result,peer,_,_=self.run_guard(peer,state)
            self.assertEqual(result['reason'],kind)
            self.assertEqual(peer.calls,[])

    def test_offline_event_preserves_account_for_verification(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'events.jsonl'
            event={'kind':'KickedOffLine','accountId':ACCOUNT,'time':NOW-250,'reason':EXPIRED_NOTICE}
            path.write_text(json.dumps(event)+'\n',encoding='utf8')
            self.assertEqual(module.read_offline_event(path),event)

    def test_missing_quick_record_can_use_bound_credential(self):
        peer=Peer();peer.accounts=[]
        state,peer,_,_=self.run_guard(peer)
        self.assertEqual(peer.calls,[('password',ACCOUNT)]);self.assertEqual(state['phase'],'online')

    def test_no_secret_fails_closed_without_password_request(self):
        state,peer,_,_=self.run_guard(credential=False)
        self.assertEqual(peer.calls,[('quick',ACCOUNT)]);self.assertTrue(state['requiresAction'])
        self.assertEqual(state['reason'],'credential_missing')

    def test_invalid_password_captcha_and_device_stop_across_restarts(self):
        for kind in ['invalid','captcha','device','unknown']:
            with self.subTest(kind=kind):
                state,peer,_,_=self.run_guard(Peer(password=kind))
                self.assertTrue(state['requiresAction']);self.assertEqual(state['phase'],'needs_action')
                new_peer=Peer()
                state,_,_,_=self.run_guard(new_peer,copy.deepcopy(state),now=NOW+3600)
                self.assertEqual(new_peer.calls,[],'重启/时间经过不能绕过人工验证阻断')

    def test_transient_network_failure_has_persistent_backoff(self):
        state,peer,_,_=self.run_guard(Peer(quick='transient'))
        self.assertEqual(peer.calls,[('quick',ACCOUNT)]);self.assertGreaterEqual(state['nextAttemptAt'],NOW+180)
        state,new,_,_=self.run_guard(Peer(),copy.deepcopy(state),now=NOW+60)
        self.assertEqual(new.calls,[])

    def test_newly_offline_and_existing_initialization_do_not_login(self):
        state,peer,_,_=self.run_guard(state={})
        self.assertEqual(peer.calls,[]);self.assertEqual(state['phase'],'waiting')
        peer=Peer();peer.phase='initializing'
        state,peer,_,_=self.run_guard(peer)
        self.assertEqual(peer.calls,[]);self.assertEqual(state['phase'],'waiting')

    def test_accepted_does_not_mean_online(self):
        peer=Peer(quick='accepted');peer.after_accept=False
        state,peer,_,_=self.run_guard(peer)
        self.assertNotEqual(state['phase'],'online');self.assertEqual(peer.calls,[('quick',ACCOUNT)])

    def test_wrong_online_account_or_webui_account_never_login(self):
        for mismatch in ['online','webui']:
            peer=Peer()
            if mismatch=='online':peer.gateway_status=lambda:{'online':True,'good':True,'accountId':'900000002'}
            else:peer.account='900000002'
            state,peer,_,_=self.run_guard(peer)
            self.assertTrue(state['requiresAction']);self.assertEqual(peer.calls,[])

    def test_budget_and_lease_persist_before_mutation(self):
        state={'version':1,'accountId':ACCOUNT,'firstOfflineAt':NOW-240};snapshots=[];peer=Peer()
        def save(s):snapshots.append(copy.deepcopy(s))
        def before(kind):
            self.assertEqual(snapshots[-1]['attempts'][-1]['kind'],kind)
            self.assertGreaterEqual(snapshots[-1]['inFlightUntil'],NOW+180)
        peer.before_mutation=before
        Guard(peer,state,lambda:'a'*32,save,now=lambda:NOW,sleep=lambda _:None).run()
        self.assertEqual(len(peer.calls),2)

    def test_process_crash_lease_prevents_replaying_backend_request(self):
        s={'version':1,'accountId':ACCOUNT,'firstOfflineAt':NOW-600,'inFlightUntil':NOW+100,
           'attempts':[{'kind':'quick','time':NOW-30}]}
        state,peer,_,_=self.run_guard(state=s)
        self.assertEqual(peer.calls,[])

    def test_hourly_budgets_are_separate_and_survive_restart(self):
        for kind,count in [('quick',3),('password',2)]:
            s={'version':1,'accountId':ACCOUNT,'firstOfflineAt':NOW-600,
               'attempts':[{'kind':kind,'time':NOW-400-i*10} for i in range(count)]}
            peer=Peer()
            if kind=='password':peer.accounts=[]
            state,peer,_,_=self.run_guard(peer,s)
            self.assertEqual(peer.calls,[]);self.assertEqual(state['reason'],'budget_exhausted')

    def test_transport_exception_never_falls_through_to_password(self):
        peer=Peer()
        def hung(_):raise module.GuardError('transport')
        peer.quick_login=hung
        state,peer,_,reads=self.run_guard(peer)
        self.assertEqual(reads,[]);self.assertGreater(state['nextAttemptAt'],NOW)

    def test_three_read_only_failures_reach_fifteen_minute_backoff_then_recover(self):
        state={'version':1,'accountId':ACCOUNT,'firstOfflineAt':NOW-1000}
        current=NOW
        for delay in [180,300,900]:
            peer=Peer()
            def offline():raise module.GuardError('transport')
            peer.login_status=offline
            state,peer,_,_=self.run_guard(peer,state,now=current)
            self.assertEqual(peer.calls,[]);self.assertFalse(state['requiresAction'])
            self.assertEqual(state['nextAttemptAt'],current+delay)
            current+=delay+1
        state,peer,_,_=self.run_guard(Peer(),state,now=current)
        self.assertEqual(state['phase'],'online')

    def test_rolling_budget_waits_for_window_instead_of_permanent_manual_lock(self):
        state={'version':1,'accountId':ACCOUNT,'firstOfflineAt':NOW-1000,
               'attempts':[{'kind':'quick','time':NOW-100-i} for i in range(3)]}
        state,peer,_,_=self.run_guard(state=state)
        self.assertEqual(state['phase'],'cooldown');self.assertFalse(state['requiresAction'])
        state,peer,_,_=self.run_guard(state=state,now=NOW+3601)
        self.assertEqual(state['phase'],'online')

    def test_core_online_but_onebot_down_does_not_reauthenticate(self):
        peer=Peer();peer.login_status=lambda:{'phase':'ready','coreReady':True,'isLogin':True}
        state,peer,_,_=self.run_guard(peer)
        self.assertEqual(peer.calls,[]);self.assertEqual(state['reason'],'onebot_unavailable')

    def test_manual_verification_clears_only_after_real_online(self):
        s={'version':1,'accountId':ACCOUNT,'requiresAction':True,'reason':'device','phase':'needs_action'}
        state,peer,_,reads=self.run_guard(Peer(online=True),s)
        self.assertFalse(state['requiresAction']);self.assertEqual(state['phase'],'online');self.assertEqual(reads,[])

    def test_private_state_round_trip_and_corruption_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'state.json'
            self.assertEqual(module.load_state(p),{})
            module.atomic_json(p,{'version':1,'accountId':ACCOUNT,'attempts':[]})
            self.assertEqual(module.load_state(p)['accountId'],ACCOUNT)
            p.write_text('{bad',encoding='utf8')
            with self.assertRaises(module.GuardError):module.load_state(p)

    def test_response_classification_does_not_trust_success_code_over_verification(self):
        self.assertEqual(module.classify_login({'code':0,'data':{'needNewDevice':True}})['kind'],'device')
        self.assertEqual(module.classify_login({'code':0,'data':{'needCaptcha':True}})['kind'],'captcha')
        self.assertEqual(module.classify_login({'code':-1,'message':'你的用户身份已失效，请重新登录'})['kind'],'expired')
        self.assertEqual(module.classify_login({'code':-1,'message':'网络连接异常!'})['kind'],'transient')
        self.assertEqual(module.classify_login({'code':-1,'message':'密码错误，请重新登录'})['kind'],'invalid')

    def test_recovered_cycle_clears_initialization_and_acceptance_markers(self):
        s={'version':1,'accountId':ACCOUNT,'acceptedAt':NOW-500,'initializingAt':NOW-500}
        state,_,_,_=self.run_guard(Peer(online=True),s)
        self.assertNotIn('acceptedAt',state);self.assertNotIn('initializingAt',state)

    def test_unexpected_client_error_is_fixed_manual_state_without_secret(self):
        peer=Peer()
        def bad(_):raise ValueError('fixture-secret-response')
        peer.quick_login=bad
        state,peer,_,_=self.run_guard(peer)
        self.assertEqual(state['reason'],'unknown');self.assertTrue(state['requiresAction'])
        self.assertNotIn('fixture-secret-response',str(state))

    def test_client_schema_errors_are_controlled(self):
        config={'snowluma':{'accountId':ACCOUNT,'httpUrl':'http://127.0.0.1:13000','accessToken':'fixture'}}
        web={'autoLoginAccount':ACCOUNT,'token':'fixture-web-token'}
        for data in [[1],True,'raw-secret']:
            with self.subTest(data=data):
                client=module.GatewayClient(config,web,request=lambda *a,**k:{'status':'ok','retcode':0,'data':data})
                self.assertIsNone(client.gateway_status())
                def request(url,*_):
                    return {'code':0,'data':{'Credential':'fixture'}} if url.endswith('/auth/login') else {'code':0,'data':data}
                client=module.GatewayClient(config,web,request=request)
                with self.assertRaises(module.GuardError):client.login_status()
        for body in [[],{'code':0,'data':'wrong'}]:
            client=module.GatewayClient(config,web,request=lambda *a:body)
            with self.assertRaises(module.GuardError):client.login_status()

    def test_wrong_credential_account_and_corrupt_state_never_become_login_input(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'qq-login';file.write_text('{"accountId":"900000002","passwordMd5":"'+ 'a'*32+'"}',encoding='utf8')
            with mock.patch.dict(os.environ,{'CREDENTIALS_DIRECTORY':temp}):
                with self.assertRaises(module.GuardError) as error:module.read_credential(ACCOUNT)
                self.assertEqual(error.exception.code,'credential_account_mismatch')
            for state in [{'version':1,'failureCount':'bad'}, {'version':1,'attempts':[{'kind':'quick','time':True}]}]:
                file.write_text(__import__('json').dumps(state),encoding='utf8')
                with self.assertRaises(module.GuardError):module.load_state(file)

    def test_incomplete_login_status_never_triggers_login(self):
        config={'snowluma':{'accountId':ACCOUNT,'httpUrl':'http://127.0.0.1:13000'}}
        web={'autoLoginAccount':ACCOUNT,'token':'fixture'}
        valid={'isLogin':False,'coreReady':False,'loginPhase':'waiting_qrcode'}
        for data in [{},dict(valid,isLogin='true'),dict(valid,coreReady='true'),dict(valid,loginPhase=''),dict(valid,loginPhase=None)]:
            with self.subTest(data=data):
                calls=[]
                def request(url,*_):
                    calls.append(url.rsplit('/',1)[-1])
                    if url.endswith('/auth/login'):return {'code':0,'data':{'Credential':'fixture'}}
                    if url.endswith('/CheckLoginStatus'):return {'code':0,'data':data}
                    if url.endswith('/GetQuickLoginList'):return {'code':0,'data':[ACCOUNT]}
                    return {'status':'failed'}
                client=module.GatewayClient(config,web,request=request)
                state,_,_,reads=self.run_guard(client)
                self.assertEqual(state['reason'],'transport');self.assertEqual(reads,[])
                self.assertNotIn('SetQuickLogin',calls);self.assertNotIn('PasswordLogin',calls)

class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sink_hits=0
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length','0')))
                if self.path=='/redirect':
                    self.send_response(302);self.send_header('Location','/sink');self.end_headers();return
                if self.path=='/sink':cls.sink_hits+=1
                if self.path=='/large':body=b'x'*65537
                elif self.path=='/drip':
                    self.send_response(200);self.send_header('Content-Length','100');self.end_headers()
                    try:
                        for _ in range(100):self.wfile.write(b'x');self.wfile.flush();time.sleep(.025)
                    except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
                    return
                else:body=b'{"code":0}'
                self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers()
                try:self.wfile.write(body)
                except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
        cls.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.server.daemon_threads=True;cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join(timeout=2)
    def client(self):return module.GatewayClient({'snowluma':{'accountId':ACCOUNT,'httpUrl':'http://127.0.0.1:13000'}},{'autoLoginAccount':ACCOUNT,'token':'fixture'})
    def url(self,suffix):return 'http://127.0.0.1:'+str(self.server.server_address[1])+suffix
    def test_redirect_and_oversize_are_rejected(self):
        for suffix in ['/redirect','/large']:
            with self.assertRaises(module.GuardError):self.client()._http(self.url(suffix),{},{'Authorization':'Bearer fixture'},1)
        self.assertEqual(self.sink_hits,0)
    def test_environment_proxy_not_used(self):
        with mock.patch.dict(os.environ,{'HTTP_PROXY':'http://127.0.0.1:1','http_proxy':'http://127.0.0.1:1','NO_PROXY':'','no_proxy':''}):
            self.assertEqual(self.client()._http(self.url('/ok'),{}, {},1)['code'],0)
    @unittest.skipUnless(hasattr(__import__('signal'),'setitimer'),'生产Linux完整请求时限测试')
    def test_drip_response_cannot_extend_total_deadline(self):
        start=time.monotonic()
        with self.assertRaises(module.GuardError):self.client()._http(self.url('/drip'),{},{},.15)
        self.assertLess(time.monotonic()-start,.65)

if __name__=='__main__':unittest.main(verbosity=2)
