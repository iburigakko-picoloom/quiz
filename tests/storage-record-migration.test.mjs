import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';

const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
    && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
process.on('exit', () => hook.deregister());
const values = new Map();
let failWrites = false;
globalThis.localStorage = {
  get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key),
  setItem(key, value) { if (failWrites) throw new DOMException('full', 'QuotaExceededError'); values.set(key, String(value)); },
};
globalThis.window = { dispatchEvent() {} };
const factory = new IDBFactory();
globalThis.indexedDB = factory;
const storage = await import('../src/storage.ts');
const records = await import('../src/utils/appRecordStorage.ts');
const timestamp = '2026-09-28T01:00:00.000Z';
const initial = { ...storage.createEmptyAppData(), folders: [{ id: 'folder', name: 'Legacy', createdAt: timestamp, updatedAt: timestamp }] };
async function read(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
  });
}

test('legacy v2 migration, failed saves, fallback recovery and missing-record recovery retain user data', async () => {
  const legacy = await new Promise((resolve, reject) => {
    const request = factory.open('quiz-make-app-data-v1', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('appData'); request.result.createObjectStore('appDataBackups');
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise(resolve => {
    const tx = legacy.transaction('appData', 'readwrite');
    tx.objectStore('appData').put(JSON.stringify(initial), storage.APP_DATA_STORAGE_KEY);
    tx.objectStore('appData').put(timestamp, `${storage.APP_DATA_STORAGE_KEY}:saved-at`);
    tx.oncomplete = resolve;
  });
  legacy.close();
  assert.deepEqual(await storage.loadAppDataAsync(), initial);
  const db = await storage.openAppDb();
  assert.equal(db.version, 7);
  assert.equal(await read(db, 'appRecordMeta', 'state'), undefined, 'schema upgrade alone never commits a partial migration');

  // A real transaction abort plus exhausted localStorage leaves the legacy data intact.
  const realTransaction = db.transaction.bind(db);
  let failRecordWrites = true;
  db.transaction = (...args) => {
    const tx = realTransaction(...args);
    if (failRecordWrites && args[1] === 'readwrite' && [...args[0]].includes('appRecords')) {
      const request = tx.objectStore('appRecordMeta').get('state');
      request.onsuccess = () => {
        failWrites = true;
        queueMicrotask(() => tx.abort());
      };
    }
    return tx;
  };
  const next = structuredClone(initial); next.folders[0].name = 'Changed';
  const originalError = console.error;
  console.error = () => {};
  try { assert.equal(await storage.saveAppData(next), false); }
  finally { console.error = originalError; failWrites = false; failRecordWrites = false; }
  assert.deepEqual(await storage.loadAppDataAsync(), initial);
  assert.equal(await read(db, 'appRecordMeta', 'state'), undefined);
  assert.deepEqual(await records.readAppOutbox(db), []);

  assert.equal(await storage.saveAppData(next), true);
  assert.deepEqual(await storage.loadAppDataAsync(), next);
  assert.equal(await read(db, 'appData', storage.APP_DATA_STORAGE_KEY), JSON.stringify(initial), 'legacy snapshot remains byte-for-byte unchanged');
  assert.equal((await records.readAppOutbox(db)).length, 1);
  const third = structuredClone(next); third.folders[0].name = 'Newest';
  assert.equal(await storage.saveAppData(third), true);
  assert.deepEqual((await records.readPreviousAppRecords(db)).data, next);
  forceCloseDatabase(db);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(await storage.loadAppDataAsync(), third, 'forced closure reopens the committed database');

  const reopened = await storage.openAppDb();
  await new Promise(resolve => {
    const tx = reopened.transaction('appRecords', 'readwrite');
    tx.objectStore('appRecords').delete(records.appRecordKey('folders', 'folder'));
    tx.oncomplete = resolve;
  });
  assert.deepEqual(await storage.loadAppDataAsync(), next, 'only the exact previous commit is used for recovery');
  assert.notEqual(localStorage.getItem(storage.APP_DATA_RECOVERY_REQUIRED_KEY), null);
  await assert.rejects(storage.exportAppDataRaw(), /復旧/);
  assert.deepEqual(JSON.parse(await storage.exportAppDataRaw({ mode: 'recovery' })), next);
});
