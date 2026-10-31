import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {recordOffline} from '../deploy/napcat-offline-diagnostics.mjs';
const fixture=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-native-diag-'));return {dir,read:()=>fs.readFileSync(path.join(dir,'qqbot-offline-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse),close:()=>fs.rmSync(dir,{recursive:true,force:true})};};
test('镜像首次启动补齐程序，保留挂载模块、配置与插件，再启动官方入口',{skip:process.platform==='win32'},()=>{
 const h=fixture();try{
  const app=h.dir;fs.mkdirSync(path.join(app,'napcat/config'),{recursive:true});fs.mkdirSync(path.join(app,'napcat/plugins'));
  for(const [name,body] of [['napcat.mjs','patched'],['config/napcat.json','keep-config'],['plugins/user.txt','keep-plugin']])fs.writeFileSync(path.join(app,'napcat',name),body);
  fs.writeFileSync(path.join(app,'entrypoint.sh'),'#!/bin/bash\ntest -f "'+app+'/napcat/loader.js" || exit 5\necho official-entrypoint\n');
  const zip=spawnSync('python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name in ['napcat.mjs','config/napcat.json','plugins/user.txt','loader.js']:z.writestr(name,'archive')",path.join(app,'NapCat.Shell.zip')],{encoding:'utf8',timeout:5000});assert.equal(zip.status,0,zip.stderr);
  const script=fs.readFileSync('deploy/napcat-diagnostics-entrypoint.sh','utf8').replaceAll('/app',app);
  for(let n=0;n<2;n++){
   const r=spawnSync('bash',['-c',script],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/official-entrypoint/);
  }
  assert.equal(fs.readFileSync(path.join(app,'napcat/napcat.mjs'),'utf8'),'patched');
  assert.equal(fs.readFileSync(path.join(app,'napcat/config/napcat.json'),'utf8'),'keep-config');
  assert.equal(fs.readFileSync(path.join(app,'napcat/plugins/user.txt'),'utf8'),'keep-plugin');
 }finally{h.close();}
});
test('原生回调原因立即保存，分类与凭据过滤正确',()=>{
 const h=fixture();try{
  recordOffline({fs,path,directory:h.dir,accountId:'900000008',reason:'[SelfOffline] 客户端离线',time:100});
  recordOffline({fs,path,directory:h.dir,accountId:'900000008',reason:'[KickedOffLine] token=fixture-secret password=fixture-pw https://example.test/?sig=abc sk-secret123 '+ '长'.repeat(1000),time:101});
  const rows=h.read();assert.deepEqual(rows.map(x=>x.kind),['SelfOffline','KickedOffLine']);assert.equal(rows[0].time,100);
  assert.ok(rows[1].reason.length<=500);assert.ok(!/fixture-secret|fixture-pw|example.test|sk-secret123/.test(rows[1].reason));
 }finally{h.close();}
});
test('轮换有界，写入失败不抛入QQ原有恢复回调',()=>{
 const h=fixture();try{
  const file=path.join(h.dir,'qqbot-offline-events.jsonl');fs.writeFileSync(file,'x'.repeat(65537));
  recordOffline({fs,path,directory:h.dir,accountId:'900000008',reason:'[SelfOffline] 轮换'});
  assert.ok(fs.statSync(file+'.1').size<=66000);assert.match(h.read()[0].reason,/轮换/);
  fs.unlinkSync(file);fs.mkdirSync(file);assert.doesNotThrow(()=>recordOffline({fs,path,directory:h.dir,accountId:'900000008',reason:'[SelfOffline] 错误'}));
 }finally{h.close();}
});
test('实际补丁器幂等、保留原回调、未知锚点不写输出',()=>{
 const h=fixture();try{
  const file=path.join(h.dir,'napcat.mjs');
  const original='class Native { init() { const x = {\n      onOffline: (i) => {\n        pe.setQQLoginStatus(!1), pe.setQQLoginQrcodeURL("");\n      }\n};return x;} }';
  fs.writeFileSync(file,original);
  const patcher=path.resolve('deploy/patch-napcat-offline-diagnostics.py');
  const run=()=>spawnSync(process.env.PYTHON_PATH||(process.platform==='win32'?'python':'python3'),['-X','utf8',patcher,'--file',file],{encoding:'utf8',windowsHide:true,timeout:10000});
  const first=run();assert.equal(first.status,0,first.stderr);const patched=fs.readFileSync(file,'utf8');
  assert.match(patched,/qqbotRecordOffline\(/);assert.ok(patched.includes('pe.setQQLoginStatus(!1), pe.setQQLoginQrcodeURL("");'));
  assert.equal(run().status,0);assert.equal(fs.readFileSync(file,'utf8'),patched);
  fs.writeFileSync(file,'unknown version');assert.notEqual(run().status,0);assert.equal(fs.readFileSync(file,'utf8'),'unknown version');
 }finally{h.close();}
});
