import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
for(const scenario of ['online','offline','unhealthy','wrong-account'])test(`真实检查脚本退出状态：${scenario}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-health-'));
 const server=http.createServer((req,res)=>{
  const data=({'/get_login_info':{user_id:scenario==='wrong-account'?900000002:900000008,nickname:'fixture'},'/get_status':{online:scenario!=='offline',good:scenario!=='unhealthy'},'/get_group_list':[],'/get_friend_list':[{user_id:900000001}]})[req.url];
  res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  fs.mkdirSync(path.join(root,'scripts'));
  fs.copyFileSync(new URL('./check-gateway.mjs',import.meta.url),path.join(root,'scripts/check.mjs'));
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({ownerQQ:'900000001',snowluma:{httpUrl:`http://127.0.0.1:${server.address().port}`,accountId:'900000008',accessToken:'fixture'}}));
  const code=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(root,'scripts/check.mjs')],{stdio:'ignore',timeout:12000});
   child.on('error',reject);child.on('close',resolve);
  });
  assert.equal(code,scenario==='online'?0:1);
 }finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
