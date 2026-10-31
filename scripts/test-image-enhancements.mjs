import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { messageImageResult } from '../src/image-tool-result.js';

test('多图部分失败时标签与图像紧邻，原序号不重排，全部失败明确报错', () => {
  const r=messageImageResult({mediaCount:6,images:[
    {index:2,kind:'image',text:'获取失败'},
    {index:6,kind:'image',mimeType:'image/png',data:'fixture'}
  ]},'m100');
  assert.deepEqual(r.content.map(x=>x.type),['text','text','text','image']);
  assert.match(r.content[1].text,/m100.*第 2 张.*失败/);
  assert.match(r.content[2].text,/m100.*第 6 张/);
  assert.equal(r.isError,undefined);
  assert.equal(messageImageResult({images:[{index:1,text:'获取失败'}]},'m100').isError,true);
});

test('按图序号只下载指定图片，保留原消息序号且不丢掉第六张', async () => {
  const h = await bridgeHarness();
  try {
    const media = Array.from({ length: 7 }, (_, i) => ({ kind: 'image', file: `image-${i+1}.png` }));
    const result = await h.fetchMediaData(media, { indices: [6, 2] });
    assert.deepEqual(h.calls.images, ['image-2.png', 'image-6.png']);
    assert.deepEqual(Array.from(result, x => x.index), [2, 6]);
  } finally { await h.close(); }
});

test('图片选择拒绝不存在的序号，不能偷偷下载全部图片', async () => {
  const h = await bridgeHarness();
  try {
    for (const indices of [[0], [2], [1.5], [], [1,1]]) {
      await assert.rejects(h.fetchMediaData([{ kind: 'image', file: 'one.png' }], { indices }), /序号/);
    }
    assert.equal(h.calls.images.length, 0);
  } finally { await h.close(); }
});

test('真实图片路由传递图片选择，越权和无效选择均不读取媒体', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  h.appendSocialV2Message('group:456','群友','[图片]','[图片]',false,false,'12345',[
    {kind:'image',file:'first.png'}, {kind:'image',file:'second.png'}
  ],'999');
  const token = h.getSocialV2State('group:456').agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(r => server.once('listening',r));
  const base = `http://127.0.0.1:${server.address().port}/api/images/message?key=group:456&messageId=12345`;
  const headers = {'x-console-token':'fixture-console-token','x-agent-token':token};
  try {
    const good = await fetch(base+'&indices=2',{headers});
    assert.equal(good.status,200);
    const data=await good.json();
    assert.deepEqual(data.images.map(x=>x.index),[2]);
    assert.deepEqual(h.calls.images,['second.png']);
    for(const suffix of ['&indices=3','&indices=0','&indices=2,2','&indices=nope','&indices=']) {
      const bad=await fetch(base+suffix,{headers});assert.equal(bad.status,400);await bad.arrayBuffer();
    }
    const wrong=await fetch(base+'&indices=1',{headers:{...headers,'x-agent-token':'wrong'}});
    assert.equal(wrong.status,403);await wrong.arrayBuffer();
    assert.deepEqual(h.calls.images,['second.png']);
  } finally { await new Promise(r=>server.close(r)); await h.close(); }
});
