import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveListAnchor } from '../src/utils/listViewMemory.ts';
import { captureDraftDeletion, restoreDraftDeletion } from '../src/utils/draftUndo.ts';
import { runImportQueue } from '../src/utils/importQueue.ts';

test('return position follows surviving IDs after deletion and sorting', () => {
  const position = { anchorId: 'b', offset: -12, order: ['a', 'b', 'c', 'd'], focusId: 'b' };
  assert.equal(resolveListAnchor(position, ['d','c','b','a']), 'b');
  assert.equal(resolveListAnchor(position, ['d','a','c']), 'c');
  assert.equal(resolveListAnchor(position, ['a']), 'a');
  assert.equal(resolveListAnchor(position, []), undefined);
});
test('draft undo restores only the removed item and preserves later edits and new drafts', () => {
  const before = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
  const deleted = captureDraftDeletion(before, 1);
  const later = [{ id: 'c', text: 'edited C' }, { id: 'a', text: 'edited A' }, { id: 'd', text: 'new D' }];
  const restored = restoreDraftDeletion(later, deleted);
  assert.deepEqual(restored, [{ id: 'b', text: 'B' }, ...later]);
  assert.deepEqual(later, [{ id: 'c', text: 'edited C' }, { id: 'a', text: 'edited A' }, { id: 'd', text: 'new D' }]);
  assert.equal(restoreDraftDeletion(restored, deleted), restored);
});
test('interrupt waits for the current commit and resumes without saving completed items twice', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let stop = false, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const saved = [], calls = [];
  const work = runImportQueue(items, { stopped: () => stop, progress: () => {}, saved: item => saved.push(item.id), save: async item => { calls.push(item.id); started(); await new Promise(resolve => { release = resolve; }); return null; } });
  await began; stop = true; release();
  assert.equal((await work).stopped, true);
  assert.deepEqual(saved, ['a']); assert.deepEqual(calls, ['a']);
  await runImportQueue(items.filter(item => !saved.includes(item.id)), { stopped: () => false, progress: () => {}, saved: item => saved.push(item.id), save: async item => { calls.push(item.id); return null; } });
  assert.deepEqual(calls, ['a','b','c']); assert.deepEqual(saved, ['a','b','c']);
});
test('failed or thrown saves remain retryable while independent items can finish', async () => {
  const saved = [];
  const result = await runImportQueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { stopped: () => false, progress: () => {}, saved: item => saved.push(item.id), save: async item => { if (item.id === 'a') throw Error('Disk unavailable'); return item.id === 'b' ? 'Validation failed' : null; } });
  assert.deepEqual(saved, ['c']); assert.deepEqual(result.failures, [{ id: 'a', error: 'Disk unavailable' }, { id: 'b', error: 'Validation failed' }]);
});
