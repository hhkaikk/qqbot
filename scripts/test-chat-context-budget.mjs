import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';

function find(value,id){
 if(Array.isArray(value))return value.flatMap(v=>find(v,id));
 if(!value||typeof value!=='object')return [];
 return [...(value.id===id?[value]:[]),...Object.values(value).flatMap(v=>find(v,id))];
}
for(const preset of ['qq-chat','qq-chat-v2'])for(const file of [`dsh/agent-presets/${preset}/agent.cordis.yml`,`plugins/qq-agent-presets/presets/${preset}.patch.yml`]){
 test(`${file}：聊天历史在约4.8万触发摘要，保留近期原文且限制摘要成本`,()=>{
  const doc=yaml.load(fs.readFileSync(file,'utf8'));const nodes=find(doc,'compaction-basic');assert.equal(nodes.length,1);
  const c=nodes[0].config||{};
  assert.equal(c.maxTokens,4096);assert.equal(c.compactionRetries,0);assert.equal(c.headroomTokens,8192);
  for(const model of ['deepseek-flash','deepseek-v4-pro']){
   const p=c.modelPolicies?.find(p=>p.provider==='deepseek-official'&&p.model===model)||{};
   assert.ok((p.thresholdRatio??.8)<=.048,'默认80%让聊天累积到几十万Token才压缩');
   assert.equal(p.retainTokens,12000);assert.equal(p.retainRatio,undefined);
   assert.ok(p.retainTokens+c.maxTokens<1e6*p.thresholdRatio,'摘要和近期原文应留有前缀空间');
  }
  assert.equal(c.retainTokens,undefined,'不能把大窗口专用保留预算应用到其他模型');
  assert.equal(c.thresholdRatio,undefined);
 });
}
