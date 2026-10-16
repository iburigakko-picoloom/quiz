import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map(); globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.window = { dispatchEvent() {}, location:{href:'https://example.invalid/'}, addEventListener(){}, removeEventListener(){} };
const records = await import('../src/utils/appRecordStorage.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const { freezeDelta, sendDelta, applyDeltaRows } = await import('../src/utils/deltaSync.ts');
const { idbDone, idbResult, readMeta } = await import('../src/utils/blobVault.ts');
const dbs = []; after(() => dbs.forEach(db => db.close()));
const connection = { userId: 'account-a', project: 'https://example.supabase.co', syncId: 'a'.repeat(36) };
async function database() {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(crypto.randomUUID(), 1); r.onupgradeneeded = () => {records.upgradeAppRecordStores(r.result);r.result.createObjectStore('appDataBackups');}; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); dbs.push(db);
  const data = normalizeAppData({ version: 1, folders: [{ id: 'f', name: 'Folder', createdAt: '2026-10-15T00:00:00Z' }], problemSets: [], questions: [], progress: [], answerLogs: [] }).data;
  await records.saveAppRecords(db, data, new Date().toISOString());
  return { db, data };
}
const read = async (db, store, key) => { const tx = db.transaction(store), done = idbDone(tx); const result = await idbResult(tx.objectStore(store).get(key)); await done; return result; };
test('lost response reuses immutable bytes; only matching acknowledged edits are removed', async () => {
  const { db, data } = await database(); const frozen = await freezeDelta(db, connection, 'device-a');
  let committed = false, pushes = 0;
  const transport = { async delta(action, request) {
    if (action === 'receipt') return { code: 'ok', state: committed ? 'committed' : 'absent', revision: committed ? 2 : null };
    pushes++; committed = true; throw new TypeError('response lost');
  } };
  await assert.rejects(sendDelta(db, transport, frozen, async () => {}), /response lost/);
  await records.saveAppRecords(db, { ...data, folders: data.folders.map(f => ({ ...f, name: 'New edit' })) }, new Date().toISOString());
  assert.deepEqual(await freezeDelta(db, connection, 'device-a'), frozen);
  await sendDelta(db, transport, frozen, async () => {}); assert.equal(pushes, 1);
  assert.equal(await readMeta(db, 'deltaFrozen'), undefined);
  assert.equal(JSON.parse((await read(db, 'appOutbox', '["folders","f"]')).raw).name, 'New edit');
  await assert.rejects(freezeDelta(db, { ...connection, userId: 'other' }, 'device-a'), /別の同期先/);
  assert.equal(await readMeta(db, 'deltaFrozen'), undefined);
});
test('partial unrelated media and a quarantined note cannot block learning edits', async () => {
  const { db } = await database();
  const tx = db.transaction('appOutbox', 'readwrite'), done = idbDone(tx);
  for (const id of ['quizMake:notes:s:pdf', 'quizMake:notes:s:rescue']) tx.objectStore('appOutbox').put({ operationId: crypto.randomUUID(), key: records.appRecordKey('indexedDbNotes', id), collection: 'indexedDbNotes', id, raw: JSON.stringify({ dataUrl: 'data:image/png;base64,YWJj' }), position: 0, baseRevision: 0, localRevision: 2 }, records.appRecordKey('indexedDbNotes', id));
  await done;
  const frozen = await freezeDelta(db, connection, 'device-a'); assert.deepEqual(frozen.operations.map(op => op.collection), ['folders']);
});
test('one remote item preserves the replaced version and atomically advances its cursor', async () => {
  const { db } = await database();
  const tx = db.transaction('appOutbox', 'readwrite'), done = idbDone(tx); tx.objectStore('appOutbox').clear(); await done;
  const original = await read(db, 'appRecords', '["folders","f"]');
  const row = { key: original.key, collection: 'folders', id: 'f', raw: JSON.stringify({ ...JSON.parse(original.raw), name: 'Cloud' }), position: 0, revision: 3 };
  const applied = await applyDeltaRows(db, connection, [row], 3); assert.equal(applied.applied, true); assert.equal(applied.data.folders[0].name, 'Cloud');
  assert.equal((await read(db, 'recordHistory', row.key))[0].raw, original.raw);
  assert.equal((await readMeta(db, 'deltaCursor')).revision, 3);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'appRecords') throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); };
  try { await assert.rejects(applyDeltaRows(db, connection, [{ ...row, raw: original.raw, revision: 4 }], 4)); } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await readMeta(db, 'deltaCursor')).revision, 3); assert.equal((await read(db, 'appRecords', row.key)).raw, row.raw);
});
test('legacy bootstrap does not publish older unknown originals as fresh edits', async () => {
  const { db } = await database(); const local = await read(db, 'appOutbox', '["folders","f"]');
  const remote = { key: local.key, collection: local.collection, id: local.id, raw: JSON.stringify({ ...JSON.parse(local.raw), name: 'Existing cloud' }), position: 0, revision: 9 };
  const result = await applyDeltaRows(db, connection, [remote], 9, {}, true);
  assert.equal(result.data.folders[0].name, 'Existing cloud'); assert.equal(await read(db, 'appOutbox', local.key), undefined);
  assert.equal((await read(db, 'appRecordConflicts', `legacy:${local.operationId}`)).local.raw, local.raw);
});

test('checkpoint protects a hydrated legacy PDF and it remains available offline', async () => {
  const {db}=await database(),vault=await import('../src/utils/blobVault.ts');
  const id='quizMake:notes:s:__material_pdf_pdf',key=records.appRecordKey('indexedDbNotes',id),bytes=new Blob(['%PDF-1.4 local original'],{type:'application/pdf'});
  const ref={sha256:await vault.blobHash(bytes),size:bytes.size,type:bytes.type};
  const remote=JSON.stringify({kind:'quiz-material-remote-file',version:1,materialId:'pdf',path:'old/pdf',sha256:ref.sha256,size:ref.size,updatedAt:'2026-10-16T00:00:00Z'});
  const original=JSON.stringify({kind:'quiz-material-file',version:1,materialId:'pdf',dataUrl:await vault.blobDataUrl(bytes),updatedAt:'2026-10-16T00:00:00Z'});
  const tx=db.transaction(['appOutbox','appRecords','categoryNotes'],'readwrite'),done=idbDone(tx);tx.objectStore('appOutbox').clear();
  tx.objectStore('appRecords').put({key,id,collection:'indexedDbNotes',raw:remote,position:0,serverRevision:1,localRevision:1},key);tx.objectStore('categoryNotes').put(original,id);await done;
  // Force a fresh authoritative snapshot after creating the legacy fixture.
  await vault.writeMeta(db,'state',{...await readMeta(db,'state'),commitId:crypto.randomUUID()});
  await applyDeltaRows(db,connection,[{key,id,collection:'indexedDbNotes',raw:remote,position:0,revision:2}],2,{},true);
  const {listProtectedOriginals,readProtectedOriginal}=await import('../src/utils/recordConflictRecovery.ts');
  const rescued=await listProtectedOriginals(db);assert.equal(rescued.length,1);assert.equal(await readProtectedOriginal(db,rescued[0]),original);
  const recovered=await(await import('../src/utils/materialStorage.ts')).recoverCachedMaterial(db,id,ref);assert.equal(await recovered.text(),await bytes.text());
});

test('new material imports after migration completion are immediately transferable references',async()=>{
  const {db,data}=await database(),vault=await import('../src/utils/blobVault.ts');await vault.writeMeta(db,'deltaEnabled',{version:3});await vault.writeMeta(db,'blobMigration',{complete:true,after:'z'});
  const id='quizMake:notes:s:__material_pdf_import',raw=JSON.stringify({kind:'quiz-material-file',version:1,materialId:'import',dataUrl:'data:application/pdf;base64,JVBERg==',updatedAt:'2026-10-16T00:00:00Z'});
  await records.saveAppRecords(db,data,new Date().toISOString(),undefined,[],undefined,true,{[id]:raw});
  const pending=await read(db,'appOutbox',records.appRecordKey('indexedDbNotes',id));assert.equal(pending.transferReady,1);assert.ok(vault.parseBlobNote(pending.raw));assert.equal(await vault.unpackBlobNote(db,pending.raw),raw);
  assert.ok((await freezeDelta(db,connection,'device-a')).operations.some(op=>op.id===id));
});
