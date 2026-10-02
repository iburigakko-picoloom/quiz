import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
    && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
process.on('exit', () => hook.deregister());
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key), setItem: (key, value) => values.set(key,String(value)) };
globalThis.window = { dispatchEvent() {} };
globalThis.indexedDB = new IDBFactory();
const storage = await import('../src/storage.ts');
const notes = await import('../src/utils/noteStorage.ts');
const records = await import('../src/utils/appRecordStorage.ts');
const { openCoLocatedNoteDb } = await import('../src/utils/noteRecordMigration.ts');
const { queueNoteRecordWrite, NOTE_RECORD_TRANSACTION_STORES } = await import('../src/utils/auxiliaryRecordStorage.ts');
const complete = tx => new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error ?? new Error('aborted')); });
async function get(db, store, key) { const tx=db.transaction(store); const done=complete(tx); const req=tx.objectStore(store).get(key); await done; return req.result; }

test('notes migrate without deleting the old database and atomically save their Outbox and revisions', async () => {
  const key='quizMake:notes:s:category'; const initial=JSON.stringify({ dataUrl:'old',updatedAt:'2026-09-29T00:00:00Z' });
  const legacy=await new Promise((resolve,reject) => {
    const req=indexedDB.open('quiz-make-notes-v1',2);
    req.onupgradeneeded=()=>{req.result.createObjectStore('categoryNotes');req.result.createObjectStore('categoryNoteBackups');};
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
  let tx=legacy.transaction('categoryNotes','readwrite'); let done=complete(tx); tx.objectStore('categoryNotes').put(initial,key); await done;
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()),true);
  const db=await storage.openAppDb(); const original=db.transaction.bind(db);
  db.transaction=(stores,...args)=>{
    const transaction=original(stores,...args);
    if(args[0]==='readwrite' && stores.includes('categoryNotes')) {
      const req=transaction.objectStore('appRecordMeta').get('notesMigrationV1');
      req.onsuccess=()=>queueMicrotask(()=>transaction.abort());
    }
    return transaction;
  };
  await assert.rejects(openCoLocatedNoteDb());
  db.transaction=original;
  assert.equal(await get(db,'appRecordMeta','notesMigrationV1'),undefined);
  assert.equal(await get(db,'categoryNotes',key),undefined);
  assert.equal(await get(legacy,'categoryNotes',key),initial);
  await openCoLocatedNoteDb();
  assert.equal(await notes.loadCategoryNoteRaw(key),initial);
  assert.equal(await get(db,'appRecordMeta','notesMigrationV1'),1);
  assert.equal((await records.readAppOutbox(db)).find(op=>op.id===key).raw,initial);
  const state=await get(db,'appRecordMeta','state');
  const edited=JSON.stringify({ dataUrl:'edited',updatedAt:'2026-09-29T01:00:00Z' });
  await notes.saveCategoryNoteRaw(key,edited);
  assert.equal(await get(db,'categoryNotes',key),edited);
  assert.equal((await records.readAppOutbox(db)).find(op=>op.id===key).raw,edited);
  assert.equal((await get(db,'appRecordMeta','state')).revision,state.revision+1);
  assert.equal(await get(legacy,'categoryNotes',key),initial,'legacy recovery copy stays untouched');
  const savedOp=(await records.readAppOutbox(db)).find(op=>op.id===key);
  tx=db.transaction(NOTE_RECORD_TRANSACTION_STORES,'readwrite'); done=complete(tx);
  tx.objectStore('categoryNotes').put('interrupted',key); queueNoteRecordWrite(tx,key,'interrupted'); tx.abort();
  await assert.rejects(done);
  assert.equal(await get(db,'categoryNotes',key),edited);
  assert.deepEqual((await records.readAppOutbox(db)).find(op=>op.id===key),savedOp);
  await notes.replaceCategoryNotesRaw({}, { onlyChanged:true });
  assert.equal(await get(db,'categoryNotes',key),undefined);
  assert.equal((await records.readAppOutbox(db)).find(op=>op.id===key).raw,null);
  assert.equal(await get(legacy,'categoryNotes',key),initial);
  legacy.close(); db.close();
});
