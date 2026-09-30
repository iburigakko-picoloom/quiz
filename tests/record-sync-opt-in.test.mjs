import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecordSyncOptedIn, setRecordSyncOptIn } from '../src/utils/recordSyncOptIn.ts';

test('V2 opt-in is per connection, persists across calls, and fails closed when storage is unavailable', () => {
  const priorStorage = globalThis.localStorage;
  const priorWindow = globalThis.window;
  const values = new Map();
  let settingsEvents = 0;
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  globalThis.window = { dispatchEvent: () => { settingsEvents++; } };
  try {
    assert.equal(isRecordSyncOptedIn('connection-a'), false);
    assert.deepEqual(setRecordSyncOptIn('connection-a', true), { ok: true });
    assert.equal(isRecordSyncOptedIn('connection-a'), true);
    assert.equal(isRecordSyncOptedIn('connection-b'), false);
    assert.deepEqual(setRecordSyncOptIn('connection-a', false), { ok: true });
    assert.equal(isRecordSyncOptedIn('connection-a'), false);
    assert.equal(settingsEvents, 2);
    globalThis.localStorage.setItem = () => { throw new Error('quota'); };
    assert.equal(setRecordSyncOptIn('connection-a', true).ok, false);
    assert.equal(isRecordSyncOptedIn('connection-a'), false);
    globalThis.localStorage.getItem = () => { throw new Error('blocked'); };
    assert.equal(isRecordSyncOptedIn('connection-a'), false);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
