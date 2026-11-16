import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAndPublishRecords } from '../src/utils/recordImportPublication.ts';

test('a rejected import leaves the local view available for a successful retry', async () => {
  for (const failure of [new Error('companion conflict'), new DOMException('full', 'QuotaExceededError')]) {
    let loadError = null;
    let view = 'original';
    const publish = async result => { view = result.data; };
    const block = error => { loadError = error; };
    await assert.rejects(applyAndPublishRecords(async () => { throw failure; }, publish, block), error => error === failure);
    assert.equal(loadError, null);
    assert.equal(view, 'original');
    const result = { applied: true, data: 'received' };
    assert.equal(await applyAndPublishRecords(async () => result, publish, block), result);
    assert.equal(view, 'received');
    assert.equal(loadError, null);
  }
});

test('a failed projection after commit still blocks edits to a stale local view', async () => {
  const failure = new DOMException('projection full', 'QuotaExceededError');
  let loadError = null;
  await assert.rejects(applyAndPublishRecords(async () => ({ applied: true }), async () => { throw failure; }, error => { loadError = error; }), error => error === failure);
  assert.equal(loadError, failure);
});

test('deferred imports and unresolved conflicts do not publish or block the view', async () => {
  for (const result of [{ applied: false, deferred: true }, { applied: false, conflicts: [{}] }]) {
    assert.equal(await applyAndPublishRecords(async () => result, async () => assert.fail('must not publish'), () => assert.fail('must not block')), result);
  }
});
