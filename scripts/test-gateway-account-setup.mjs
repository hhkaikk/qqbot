// 在隔离目录执行真实安装脚本的 Python 配置段；不运行 Docker 或触碰服务器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=fs.readFileSync(new URL('../deploy/install-napcat.sh',import.meta.url),'utf8');
const code=script.match(/python3 - <<'PY'\r?\n([\s\S]*?)\r?\nPY/)[1];
const python=process.env.TEST_PYTHON || (process.platform==='win32'?'python':'python3');
for(const account of ['900000008','123456789','../bad']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-account-'));
 try{
  fs.mkdirSync(path.join(root,'app'));fs.mkdirSync(path.join(root,'gateway/config'),{recursive:true});
  const cfg={ownerQQ:'900000001',snowluma:{accountId:account,accessToken:'fixture-token'},allow:{private:['900000003']}};
  fs.writeFileSync(path.join(root,'app/config.json'),JSON.stringify(cfg));
  const webui={token:'fixture-webui',autoLoginAccount:'900000002',port:6099,theme:'fixture'};
  fs.writeFileSync(path.join(root,'gateway/config/webui.json'),JSON.stringify(webui));
  const run=spawnSync(python,['-c',code.replace("pathlib.Path('/opt/qqbot')",`pathlib.Path(${JSON.stringify(root)})`)],{encoding:'utf8'});
  if(account==='../bad'){
   assert.notEqual(run.status,0);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'gateway/config/webui.json'))),webui);
  }else{
   assert.equal(run.status,0,run.stderr);
   const after=JSON.parse(fs.readFileSync(path.join(root,'gateway/config/webui.json')));
   assert.equal(after.autoLoginAccount,account);assert.equal(after.token,webui.token);assert.equal(after.theme,webui.theme);
   assert.ok(fs.existsSync(path.join(root,`gateway/config/onebot11_${account}.json`)));
   assert.ok(!fs.existsSync(path.join(root,'gateway/config/onebot11_900000002.json')));
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
console.log('网关安装账号迁移：新号、其他账号、非法账号测试通过');
