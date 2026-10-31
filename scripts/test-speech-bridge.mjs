import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('语音转写以真实文字进入消息，失败提示不猜测', async () => {
  const h = await bridgeHarness();
  try {
    assert.match(await h.segmentsToText([{type:'record',data:{transcript:'我是小明'}}]), /语音转写.*我是小明/);
    assert.match(await h.segmentsToText([{type:'record',data:{}}]), /未能转写.*勿猜测/);
  } finally { await h.close(); }
});

test('合成共用发送护栏、NapCat容器传输及清理，记入真实朗读内容', async () => {
  let cleaned = 0, synth = 0;
  const h = await bridgeHarness({config:{snowluma:{gateway:'napcat',accountId:'999'},socialV2:{voice:{enabled:true,dynamicText:true},tools:{sendVoice:true}}},globals:{
    createSpeechSynthesizer: () => ({synthesize: async text => { synth++; assert.equal(text,'你好，我是大肥鱼'); const p=path.join(h.temp,'speech.mp3');fs.writeFileSync(p,'audio');return {path:p,cleanup:async()=>{cleaned++;fs.unlinkSync(p);}};}}),
    inspectAudio: async () => ({ok:true,size:5,duration:1,warnings:[]}),
  }});
  h.setMode('reserved2');h.setSelfIdentity('大肥鱼','999');
  try {
    const result=await h.sendSpeechForV2('private:123','你好，我是大肥鱼');
    assert.equal(result.verification.confirmed,true);
    const sent=h.calls.http.find(x=>x.url.endsWith('/send_private_msg'));
    assert.equal(sent.body.message[0].data.file,'base64://YXVkaW8=');
    assert.equal(synth,1);assert.equal(cleaned,1);
    assert.match(JSON.stringify(h.getSocialV2State('private:123').recentMessages),/你好，我是大肥鱼/);
    await assert.rejects(h.sendSpeechForV2('private:888','你好'));
    assert.equal(synth,1);
  } finally {await h.close();}
});

test('文本边界及关闭功能在合成前拒绝',async()=>{
  const h=await bridgeHarness();
  try {assert.throws(()=>h.validateSpeechText('你好'),/未启用/);}
  finally{await h.close();}
});

const latch = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('真实来信处理：转写期间后续文字等待，入库保留语音在前的顺序', async () => {
  const entered = latch(), release = latch();
  const h = await bridgeHarness({
    config: { socialV2: { voice: { enabled: true, transcribe: true } } },
    globals: {
      createOneBotHttp: () => async (action, params) => {
        assert.equal(action, 'fetch_ptt_text');
        assert.equal(params.message_id, '71');
        entered.resolve();
        await release.promise;
        return { text: '语音里的原问题' };
      },
    },
  });
  h.setMode('reserved2');
  h.setSelfIdentity('大肥鱼', '999');
  const key = 'private:123';
  let first, second;
  try {
    first = h.handleIncoming('private', 123, {
      user_id: 123, self_id: 999, message_id: 71,
      message: [{ type: 'record', data: { file: 'fixture.amr' } }],
    }, h.cfg);
    await entered.promise;
    let textCompleted = false;
    second = h.handleIncoming('private', 123, {
      user_id: 123, self_id: 999, message_id: 72,
      message: [{ type: 'text', data: { text: '紧接着的文字补充' } }],
    }, h.cfg).then(() => { textCompleted = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(textCompleted, false, 'ASR 未返回时后续文字不能越过语音');
    assert.equal(h.getSocialV2State(key).recentMessages.length, 0);
    release.resolve();
    await Promise.all([first, second]);
    const received = h.getSocialV2State(key).recentMessages;
    assert.deepEqual(Array.from(received, message => String(message.messageId)), ['71', '72']);
    assert.match(received[0].text, /语音转写.*语音里的原问题/);
    assert.equal(received[1].text, '紧接着的文字补充');
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await h.close();
  }
});

for (const change of ['暂停', '关闭语音', '关闭文字合成', '关闭语音工具', '切换静默']) {
  test(`合成期间${change}：不发消息且清理合成文件`, async () => {
    const entered = latch(), release = latch();
    let cleaned = 0;
    const h = await bridgeHarness({
      config: { socialV2: { voice: { enabled: true, dynamicText: true }, tools: { sendVoice: true } } },
      globals: {
        createSpeechSynthesizer: () => ({ synthesize: async () => {
          entered.resolve();
          await release.promise;
          const output = path.join(h.temp, 'cancelled-speech.mp3');
          fs.writeFileSync(output, 'audio');
          return { path: output, cleanup: async () => { cleaned++; fs.unlinkSync(output); } };
        } }),
        inspectAudio: async () => ({ ok: true, size: 5, duration: 1, warnings: [] }),
      },
    });
    h.setMode('reserved2');
    h.setSelfIdentity('大肥鱼', '999');
    let sending;
    try {
      // 群聊避免 owner 私聊的静默豁免。
      sending = h.sendSpeechForV2('group:456', '这是待取消的合成文字');
      const rejected = assert.rejects(sending, /暂停|关闭|取消/);
      await entered.promise;
      if (change === '暂停') h.socialV2.paused = true;
      if (change === '关闭语音') h.cfg.socialV2.voice.enabled = false;
      if (change === '关闭文字合成') h.cfg.socialV2.voice.dynamicText = false;
      if (change === '关闭语音工具') h.cfg.socialV2.tools.sendVoice = false;
      if (change === '切换静默') fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ mode: 'silent' }));
      release.resolve();
      await rejected;
      assert.equal(cleaned, 1);
      assert.equal(fs.existsSync(path.join(h.temp, 'cancelled-speech.mp3')), false);
      assert.equal(h.calls.http.filter(call => /\/send_(private|group)_msg$/.test(call.url)).length, 0);
      assert.equal(h.getSocialV2State('group:456').recentMessages.length, 0);
    } finally {
      release.resolve();
      await Promise.allSettled([sending]);
      await h.close();
    }
  });
}
