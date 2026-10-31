// 管理端费用/诊断接口；调用前仍须通过主入口认证和Origin检查。
export function createOperationsApi({spendGuard,diagnostics}={}) {
  return async function handle(req,url,sendJson,readBody) {
    if(!['/dashboard/api/operations','/dashboard/api/budget-policy'].includes(url.pathname))return false;
    if(req.headers['x-agent-token']!==undefined||req.headers['x-agent-call']!==undefined){sendJson({ok:false,error:'运行管理仅供管理员使用'},403);return true;}
    if(req.method==='GET'&&url.pathname==='/dashboard/api/operations') {
      sendJson({ok:true,budget:spendGuard.snapshot(),diagnostics:diagnostics.snapshot()});return true;
    }
    if(req.method==='POST'&&url.pathname==='/dashboard/api/budget-policy') {
      try{const policy=spendGuard.savePolicy(await readBody());sendJson({ok:true,policy});}
      catch(error){sendJson({ok:false,error:error?.code?'策略未保存，原配置保持不变，请检查服务端文件权限':error.message},error?.code?500:400);}
      return true;
    }
    sendJson({ok:false,error:'该接口不支持此操作'},405);return true;
  };
}
