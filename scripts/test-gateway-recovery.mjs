import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./test-gateway-recovery.py',import.meta.url));
const result=spawnSync(process.env.PYTHON_PATH||(process.platform==='win32'?'python':'python3'),['-X','utf8',script],{
  encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,PYTHONIOENCODING:'utf-8'},
});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(result.error)process.stderr.write('Python隔离回归未能运行。\n');
process.exit(result.status===0?0:1);
