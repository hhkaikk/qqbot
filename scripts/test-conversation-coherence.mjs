import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const source = fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8');
const prefix = yaml.load(source).find(row => row.id === 'persona').config.prefix;

test('群友风格不能再明确鼓励乱回、无用答案或虚构生活经历', () => {
  for (const instruction of ['可以装傻、已读乱回', '允许“装唐装傻”和“已读乱回”', '给一个离谱/没用的答案', '被问到可以说“刚没看手机”“去忙了”']) {
    assert.equal(prefix.includes(instruction), false, `仍包含混乱诱因：${instruction}`);
  }
  assert.match(prefix, /【连贯优先】/);
  assert.match(prefix, /不得编造/);
  assert.match(prefix, /纠正/);
  assert.match(prefix, /反馈/);
  assert.match(prefix, /纠错、解释和确认反馈时用直白完整的话/);
});

test('唤醒与可刷新的上下文都要求先理解当前话题，再开相关玩笑', async () => {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false } } } });
  let server;
  try {
    h.setMode('reserved2');
    const wake = h.buildWakePromptV2('group:456', 'followup');
    assert.doesNotMatch(wake, /可以装傻、已读乱回/);
    assert.match(wake, /【连贯优先】/);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(r => server.once('listening', r));
    const data = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/prompt?key=group:456',
        headers: { 'x-console-token': 'fixture-console-token' } }, res => {
        let raw = ''; res.on('data', s => raw += s); res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });
    assert.match(data.conversationHint, /【连贯优先】/);
    assert.match(data.conversationHint, /反馈/);
  } finally {
    if (server) await new Promise(r => server.close(r));
    await h.close();
  }
});

test('生成的实际安装 patch 与源保持相同的连贯规则', () => {
  const patch = fs.readFileSync(new URL('../plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml', import.meta.url), 'utf8');
  assert.ok(patch.includes('【连贯优先】'));
  assert.equal(patch.includes('给一个离谱/没用的答案'), false);
});
