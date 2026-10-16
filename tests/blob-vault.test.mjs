import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map(); globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.window = { dispatchEvent() {} };
const { upgradeAppRecordStores, saveAppRecords, appRecordKey } = await import('../src/utils/appRecordStorage.ts');
const vault = await import('../src/utils/blobVault.ts');
const { migrateNoteBlobs } = await import('../src/utils/blobMigration.ts');
const db = await new Promise((resolve, reject) => { const r = indexedDB.open('vault', 1); r.onupgradeneeded = () => upgradeAppRecordStores(r.result); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); after(() => db.close());
await saveAppRecords(db, { version: 1, folders: [], problemSets: [], questions: [], progress: [], answerLogs: [] }, new Date().toISOString());
const read = async (store, key) => { const tx = db.transaction(store), done = vault.idbDone(tx); const value = await vault.idbResult(key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key)); await done; return value; };
const raw = date => JSON.stringify({ dataUrl: 'data:image/png;base64,YWJj', updatedAt: date });
test('identical bytes share one blob across dates and sources, with a full round trip', async () => {
  const a = await vault.packBlobNote(db, raw('2026-10-15')), b = await vault.packBlobNote(db, raw('2026-10-16'));
  assert.equal((await read('contentBlobMeta')).length, 1);
  assert.equal(vault.parseBlobNote(a).blobs[0].sha256, vault.parseBlobNote(b).blobs[0].sha256);
  assert.equal(await vault.unpackBlobNote(db, a), raw('2026-10-15'));
  assert.deepEqual(await vault.readMeta(db, 'blobUsage'), { count: 1, bytes: 3 });
});
test('one verified migration unit switches current, pending and previous copies together; restart resumes', async () => {
  const key = 'quizMake:notes:s:ink', recordKey = appRecordKey('indexedDbNotes', key), original = raw('2026-10-14');
  const row = { key: recordKey, collection: 'indexedDbNotes', id: key, raw: original, position: 0, serverRevision: 1, localRevision: 1 };
  const tx = db.transaction(['categoryNotes', 'categoryNoteBackups', 'appRecords', 'appRecordBackups', 'appOutbox'], 'readwrite'), done = vault.idbDone(tx);
  tx.objectStore('categoryNotes').put(original, key); tx.objectStore('categoryNoteBackups').put(raw('2026-10-13'), key);
  tx.objectStore('appRecords').put(row, recordKey); tx.objectStore('appRecordBackups').put({ ...row, raw: raw('2026-10-13') }, recordKey);
  tx.objectStore('appOutbox').put({ ...row, operationId: 'same-id', baseRevision: 1 }, recordKey); await done;
  await vault.writeMeta(db, 'wholeFrozen', { immutable: original });
  assert.equal(await migrateNoteBlobs(db, async () => {}, 1), false); assert.equal(await read('categoryNotes', key), original);
  await vault.writeMeta(db, 'wholeFrozen', undefined);
  assert.equal(await migrateNoteBlobs(db, async () => {}, 1), false);
  assert.equal(await vault.unpackBlobNote(db, await read('categoryNotes', key)), original);
  assert.equal((await read('appOutbox', recordKey)).operationId, 'same-id');
  assert.equal((await read('contentBlobMeta')).length, 1); assert.equal((await read('contentBlobJobs')).length, 1);
  assert.equal(await migrateNoteBlobs(db, async () => {}, 1), true);
});
test('quota failure leaves the source and migration cursor untouched', async () => {
  const key = 'quizMake:notes:z:ink', original = JSON.stringify({ dataUrl: 'data:image/png;base64,ZGVm', updatedAt: '2026-10-16' });
  const tx = db.transaction('categoryNotes', 'readwrite'), done = vault.idbDone(tx); tx.objectStore('categoryNotes').put(original, key); await done;
  await vault.writeMeta(db, 'blobMigration', undefined);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'contentBlobs') throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); };
  try { await assert.rejects(migrateNoteBlobs(db, async () => {}, 5)); } finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await read('categoryNotes', key), original);
  assert.notEqual((await vault.readMeta(db, 'blobMigration'))?.after, key);
});
test('LRU only evicts remote temporary content, retaining offline and protected originals', async () => {
  const a = await vault.putContentBlob(db, new Blob(['temp']), { origin: 'remote' });
  const b = await vault.putContentBlob(db, new Blob(['offline']), { origin: 'remote' });
  const c = await vault.putContentBlob(db, new Blob(['rescue']), { origin: 'remote' });
  await vault.setBlobOffline(db, [b], true);
  const tx = db.transaction('contentBlobRefs', 'readwrite'), done = vault.idbDone(tx); tx.objectStore('contentBlobRefs').put({ hashes: [c.sha256], protect: true }, 'rescue'); await done;
  assert.equal(await vault.trimBlobCache(db, 0), a.size);
  assert.equal(await vault.getContentBlob(db, a), undefined); assert.ok(await vault.getContentBlob(db, b)); assert.ok(await vault.getContentBlob(db, c));
});
