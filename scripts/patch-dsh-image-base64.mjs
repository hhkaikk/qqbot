// DSH 0.2.0-rc.2 的重复分组正则会在数 MB 图片上耗尽 V8 调用栈。
// 只替换已知版本/精确代码；后续 Buffer 的 base64 往返校验继续拒绝非规范编码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

export const OLD_IMAGE_BASE64 = 'const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;';
export const FIXED_IMAGE_BASE64 = 'const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;';

export function patchDshImageBase64(modulesDir, { check = false } = {}) {
  const pkg = path.join(modulesDir, '@deepseek-ai/dsh-mcp-client');
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  if (version !== '0.2.0-rc.2') throw new Error(`图片兼容补丁未验证 DSH MCP 版本 ${version}，已停止，未修改源码`);
  const file = path.join(pkg, 'lib/index.js');
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('data.toString("base64") !== block.data')) throw new Error('DSH 图片往返校验代码发生变化，已停止');
  if (source.includes(FIXED_IMAGE_BASE64) && !source.includes(OLD_IMAGE_BASE64)) return { version, changed: false, ready: true };
  if (source.split(OLD_IMAGE_BASE64).length !== 2) throw new Error('DSH 图片校验代码不符合已知版本，已停止');
  if (check) return { version, changed: false, ready: false };
  const backup = `${file}.before-qq-image-${Date.now()}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(file, source.replace(OLD_IMAGE_BASE64, FIXED_IMAGE_BASE64));
  return { version, changed: true, ready: true, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const i = process.argv.indexOf('--modules');
    if (i >= 0 && !process.argv[i + 1]) throw new Error('--modules 需要 DSH node_modules 路径');
    const result = patchDshImageBase64(i >= 0 ? process.argv[i + 1] : dshModulesDir(), { check: process.argv.includes('--check') });
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
