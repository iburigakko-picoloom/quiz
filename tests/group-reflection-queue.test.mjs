import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupReflectionQueue, watchGroupProgress, GROUP_PROGRESS_UPDATED } from '../src/utils/groupReflectionQueue.ts';

test('saved answers start immediately, coalesce while sending and cannot overwrite newer aggregates out of order', async () => {
  let release, count = 1;
  const blocked = new Promise(resolve => { release = resolve; });
  const writes = [];
  const queue = createGroupReflectionQueue(async ids => {
    const snapshot = count;
    if (!writes.length) await blocked;
    writes.push({ ids, count: snapshot });
  });
  const first = queue(['a']);
  await Promise.resolve();
  count = 2; const second = queue(['a']);
  count = 3; const third = queue(['a','b']);
  assert.equal(first, second); assert.equal(second, third);
  release(); await third;
  assert.deepEqual(writes, [{ ids: ['a'], count: 1 }, { ids: ['a','b'], count: 3 }]);
  count = 4; await queue(['b']);
  assert.deepEqual(writes.at(-1), { ids: ['b'], count: 4 });
});

test('a failed send does not lock out the next answer or retry', async () => {
  let fail = true, writes = 0;
  const queue = createGroupReflectionQueue(async () => { if (fail) throw Error('offline'); writes++; });
  await assert.rejects(queue(['a']), /offline/);
  fail = false; await queue(['a']); assert.equal(writes, 1);
});

test('visible views refresh on a timer, foreground, reconnection and local reflection; hidden and disposed views stop', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const win = new EventTarget(), doc = new EventTarget();
  let tick, cleared = false, reads = 0;
  win.setInterval = (callback, interval) => { assert.equal(interval, 10000); tick = callback; return 1; };
  win.clearInterval = () => { cleared = true; };
  doc.visibilityState = 'visible'; globalThis.window = win; globalThis.document = doc;
  try {
    const stop = watchGroupProgress(() => reads++);
    tick(); win.dispatchEvent(new Event('focus')); win.dispatchEvent(new Event('online')); win.dispatchEvent(new Event(GROUP_PROGRESS_UPDATED));
    assert.equal(reads, 4);
    doc.visibilityState = 'hidden'; tick(); win.dispatchEvent(new Event('focus')); assert.equal(reads, 4);
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(reads, 5);
    stop(); assert.equal(cleared, true); win.dispatchEvent(new Event(GROUP_PROGRESS_UPDATED)); assert.equal(reads, 5);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
