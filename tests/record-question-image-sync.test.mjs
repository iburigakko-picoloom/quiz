import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
const hook = registerHooks({ resolve(specifier, context, next) { return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier) && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context); } });
process.on('exit', () => hook.deregister());
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
globalThis.window = { dispatchEvent() {} };
globalThis.indexedDB = new IDBFactory();
const storage = await import('../src/storage.ts');
const images = await import('../src/utils/questionImageRecords.ts');
const cloud = await import('../src/utils/questionImageCloud.ts');
const sync = await import('../src/utils/recordQuestionImageSync.ts');
const pull = await import('../src/utils/recordSyncPull.ts');
const { readAppOutbox, appRecordKey } = await import('../src/utils/appRecordStorage.ts');
const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error ?? new Error('aborted')); });
const get = async (db, store, key) => { const tx = db.transaction(store); const done = complete(tx); const req = tx.objectStore(store).get(key); await done; return req.result; };
test('image body uploads before metadata and remote image commits atomically with Pull cursor', async () => {
  const raw = new Blob([Uint8Array.from([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()), true);
  await images.saveQuestionImage({ id: 'local', questionId: 'q', name: 'a.png', type: 'image/png', blob: raw, addedAt: '2026-09-29T00:00:00Z' });
  const db = await images.openQuestionImageRecordDb();
  let uploadCount = 0;
  const transport = { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', exists: async () => false,
    async upload(descriptor, blob) { assert.equal(await cloud.verifyQuestionImageBlob(blob, descriptor), true); uploadCount++; },
    async download() { return raw; } };
  const prepared = await sync.prepareQuestionImageOutbox(db, transport, async () => {});
  assert.equal(prepared.prepared, 1); assert.equal(uploadCount, 1);
  const localOp = (await readAppOutbox(db)).find(op => op.id === 'local');
  assert.equal(JSON.parse(localOp.raw).path, cloud.remoteQuestionImageDescriptor(JSON.parse(localOp.raw), transport.userId).path);
  let tx = db.transaction('appOutbox', 'readwrite'); let done = complete(tx); tx.objectStore('appOutbox').clear(); await done;
  const remoteDescriptor = { ...JSON.parse(localOp.raw), id: 'remote' };
  const remoteRaw = JSON.stringify(remoteDescriptor);
  const connection = { project: 'https://example.test', userId: transport.userId, syncId: 's' };
  const key = appRecordKey('questionImages', 'remote');
  await pull.stageRecordPullPage(db, connection, 0, { code: 'ok', cursor: 1, head: 1, hasMore: false,
    batches: [{ revision: 1, changes: [{ key, collection: 'questionImages', id: 'remote', raw: remoteRaw, position: 0, revision: 1 }] }] });
  await assert.rejects(() => pull.applyStagedRecordPull(db, connection), /画像本体/u);
  assert.equal(await get(db, 'appRecordMeta', 'pullCursor'), undefined);
  await sync.prepareStagedQuestionImages(db, transport, async () => {});
  const applied = await pull.applyStagedRecordPull(db, connection);
  assert.equal(applied.applied, true); assert.equal(applied.cursor, 1);
  const restored = await images.readQuestionImages('q', ['remote']);
  assert.equal(restored.length, 1);
  assert.equal(await cloud.verifyQuestionImageBlob(restored[0].blob, remoteDescriptor), true);
  assert.equal((await get(db, 'appRecordMeta', 'pullCursor'))?.cursor, 1);
  db.close();
});
