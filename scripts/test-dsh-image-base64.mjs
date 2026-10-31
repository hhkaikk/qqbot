import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { OLD_IMAGE_BASE64, FIXED_IMAGE_BASE64, patchDshImageBase64 } from './patch-dsh-image-base64.mjs';
// 来自真实 0.2.0-rc.2 的 decodeImage 校验路径；采用原始大图片失效的同一入口。
const body = `function decodeImage(block) {
 if (!CANONICAL_BASE64.test(block.data)) throw new Error('not canonical');
 const data = Buffer.from(block.data, "base64");
 if (data.toString("base64") !== block.data) throw new Error('not canonical');
 return data;
}`;
function fixture(version = '0.2.0-rc.2', source = OLD_IMAGE_BASE64+'\n'+body) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-image-patch-'));
  const pkg=path.join(dir,'@deepseek-ai/dsh-mcp-client');
  fs.mkdirSync(path.join(pkg,'lib'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version}));
  const file=path.join(pkg,'lib/index.js');fs.writeFileSync(file,source);
  return {dir,file,close(){fs.rmSync(dir,{recursive:true,force:true});}};
}
const decoder = source => vm.runInNewContext(source+'\ndecodeImage',{Buffer});

test('原生大图校验确实栈溢出；补丁后完整保留1B至8MiB字节',()=>{
 const f=fixture();try {
  const original=decoder(fs.readFileSync(f.file,'utf8'));
  assert.throws(()=>original({data:Buffer.alloc(8*1024*1024).toString('base64')}),/call stack/);
  const result=patchDshImageBase64(f.dir);assert.equal(result.changed,true);
  assert.equal(fs.readFileSync(result.backup,'utf8'),OLD_IMAGE_BASE64+'\n'+body);
  const fixed=decoder(fs.readFileSync(f.file,'utf8'));
  for(const n of [1,2,3,257,4*1024*1024,8*1024*1024]) {
   const bytes=Buffer.alloc(n,79);assert.deepEqual(fixed({data:bytes.toString('base64')}),bytes);
  }
 }finally{f.close();}
});

test('补丁仍拒绝非规范base64，不能因修复放宽图片编码校验',()=>{
 const fixed=decoder(FIXED_IMAGE_BASE64+'\n'+body);
 for(const data of ['Zg','Zg=','Zg===','Zh==','Zm9=','Zg==\n',' Zg==','@@==','Z=g=','____','data:image/png;base64,Zg==']) assert.throws(()=>fixed({data}),/canonical/);
 for(const data of ['Zg==','Zm8=','Zm9v','+/8=']) assert.equal(fixed({data}).toString('base64'),data);
});

test('检查只读、重复运行无改动、未知版本或源码变化拒绝改写',()=>{
 const f=fixture();try {
  assert.equal(patchDshImageBase64(f.dir,{check:true}).ready,false);
  assert.equal(fs.readFileSync(f.file,'utf8'),OLD_IMAGE_BASE64+'\n'+body);
  patchDshImageBase64(f.dir);const source=fs.readFileSync(f.file,'utf8');
  assert.equal(patchDshImageBase64(f.dir).changed,false);assert.equal(fs.readFileSync(f.file,'utf8'),source);
 }finally{f.close();}
 for(const [version,source] of [['0.3.0',OLD_IMAGE_BASE64+'\n'+body],['0.2.0-rc.2','changed'],['0.2.0-rc.2',OLD_IMAGE_BASE64+'\n'+OLD_IMAGE_BASE64+'\n'+body]]) {
  const f=fixture(version,source);try{assert.throws(()=>patchDshImageBase64(f.dir));assert.equal(fs.readFileSync(f.file,'utf8'),source);}finally{f.close();}
 }
});
