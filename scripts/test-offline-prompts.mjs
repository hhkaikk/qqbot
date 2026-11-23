import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOfflinePrompts } from '../src/offline-prompts.js';

const wake = reason => Object.freeze({ promptText: '快照投递时重建', wakeReason: reason });

test('重复唤醒合并，直接互动优先于分数更高的自动触发', () => {
  const direct = wake('nameMention');
  const previous = Object.freeze([wake('proactiveCheck'), direct]);
  const next = Object.freeze([wake('question'), wake('speaker:成员')]);
  const result = mergeOfflinePrompts(previous, next);
  assert.deepEqual(result.items, [direct]);
  assert.equal(result.coalesced, 3);
  assert.equal(previous.length, 2);assert.equal(next.length, 2);
  assert.equal(mergeOfflinePrompts([wake('question')], [wake('admin')]).items[0].wakeReason, 'admin');
  assert.equal(mergeOfflinePrompts([wake('keyword:词')], [wake('question')]).items[0].wakeReason, 'question');
});

test('普通消息、附件、静默、退场和初始化回合不合并，保持原始顺序', () => {
  for (const barrier of [
    { promptText:'普通文本' },
    { ...wake('atMention'), media:[{type:'image',file:'fixture'}] },
    { ...wake('atMention'), silent:true },
    { ...wake('atMention'), farewell:true },
    wake('bootstrap'),
  ]) {
    const items = [wake('atMention'), barrier, wake('atMention')];
    assert.deepEqual(mergeOfflinePrompts([], items).items, items);
  }
  const sameText = [{promptText:'看图',media:['甲']},{promptText:'看图',media:['乙']}];
  assert.deepEqual(mergeOfflinePrompts([],sameText).items,sameText);
});

test('失败项与并发新消息重新合队仍受容量限制，不修改原队列', () => {
  const failed = Array.from({length:40},(_,i)=>({promptText:`旧${i}`}));
  const incoming = Array.from({length:40},(_,i)=>({promptText:`新${i}`}));
  const result = mergeOfflinePrompts(failed,incoming);
  assert.equal(result.items.length,50);assert.equal(result.dropped,30);
  assert.equal(result.items[0].promptText,'旧30');assert.equal(result.items.at(-1).promptText,'新39');
  assert.equal(failed.length,40);assert.equal(incoming.length,40);
});

test('先合并重复唤醒再计算容量，不挤掉普通消息', () => {
  const old = [{promptText:'真实消息'}];
  const result = mergeOfflinePrompts(old,Array.from({length:100},()=>wake('atMention')),2);
  assert.equal(result.items.length,2);assert.equal(result.items[0],old[0]);assert.equal(result.dropped,0);
});
