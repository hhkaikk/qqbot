// 服务器只读识图验证：真实 QQ 媒体 -> MCP -> 已安装 DSH 图片投影 -> 临时附件库。
// 不调用模型、不发 QQ 消息，不输出图片内容、媒体链接或会话令牌。
// 用法：DSH_INSTALL_MODULES=... node scripts/verify-dsh-image-projection.mjs <会话key> <消息ID>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dshModulesDir } from './dsh-modules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [key, messageId] = process.argv.slice(2);
if (!/^(private|group):\d+$/.test(key || '') || !/^-?[1-9]\d*$/.test(messageId || '')) throw new Error('需要会话key和非零整数消息ID');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const state = JSON.parse(fs.readFileSync(path.join(root, 'state/social-v2.json')));
const token = state.conversations?.[key]?.agentToken;
if (!token) throw new Error('目标会话没有访问令牌');
const modules = dshModulesDir();
const load = name => import(pathToFileURL(path.join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
const [{Context}, {LocalAttachmentStore}, {createMcpToolDefinition}] = await Promise.all([
  load('cordis'), load('dsh-attachment-local'), load('dsh-mcp-client')
]);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-projection-'));
const attachments = new LocalAttachmentStore(new Context(), {dshHome:home,imageCompressionConcurrency:1});
const client = new Client({name:'qq-image-projection-check',version:'1'});
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/mcp-snowluma-safe.js')],cwd:root,stderr:'pipe'});
try {
  await client.connect(transport);
  const definition = createMcpToolDefinition({get(name) {
    if (name === 'attachments') return attachments;
    // 仅隔离模型元数据解析；真实编码校验、附件入库和投影均由安装包执行。
    if (name === 'llm') return {resolveModelInfo:async()=>({inputModalities:['image']})};
  }}, {name:'mcp__snowluma__qq_get_message_images',rawName:'qq_get_message_images',description:'只读验证',
    inputSchema:{type:'object'},call:args=>client.callTool({name:'qq_get_message_images',arguments:args}, undefined, {timeout:30000})});
  const args={key,messageId,token};
  const exec={signal:AbortSignal.timeout(40000),agent:{options:{provider:config.dsh.provider,model:config.dsh.model},session:{requestHeader:()=>undefined}}};
  const started=performance.now();
  const value=await definition.execute(args,exec);
  const fallback=definition.output.render(args,value);
  const projected=definition.projectContent(exec,{value,content:fallback});
  const images=projected?.filter(x=>x.type==='image')??[];
  const diagnostic=projected?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';
  const raw=value.content.filter(x=>x.type==='image');
  const result={ok:images.length>0&&images.length===raw.length&&!diagnostic.includes('image unavailable'),
    inputBytes:raw.map(x=>Buffer.byteLength(x.data,'base64')),projectedImages:images.length,
    dimensions:images.map(x=>({width:x.attachment?.width,height:x.attachment?.height})),elapsedMs:Math.round(performance.now()-started)};
  console.log(JSON.stringify(result));
  assert.equal(result.ok,true,'DSH 未将图片送入真实视觉附件投影');
} finally {
  await client.close();
  // 临时目录由本脚本创建，绝不触碰实际DSH_HOME附件/历史。
  assert.equal(path.dirname(home),os.tmpdir());
  assert.ok(path.basename(home).startsWith('qq-image-projection-'));
  fs.rmSync(home,{recursive:true,force:true});
}
