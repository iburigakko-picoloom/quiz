import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { largeNoteRaw } from './helpers/large-note-fixture.mjs';

globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
globalThis.window = { dispatchEvent() {} };
const storage = await import('../src/storage.ts');
const notes = await import('../src/utils/noteStorage.ts');
const { accountLocalStorage } = await import('../src/utils/accountStorage.ts');
await storage.saveAppDataAsync(storage.createEmptyAppData());
const db = await storage.openAppDb(); after(() => db.close());
const key = 'quizMake:notes:s:large-ink', raw = largeNoteRaw('2026-10-14T00:00:00Z', 's', 'large-ink');
await notes.saveCategoryNoteRaw(key, raw);
const write = async (store, value) => {
  const tx = db.transaction(store, 'readwrite');
  if (value === null) tx.objectStore(store).delete(key); else tx.objectStore(store).put(value, key);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
};

test('a healthy large note does not read its recovery copy, even if that store is unavailable', async () => {
  const get = IDBObjectStore.prototype.get, reads = [];
  IDBObjectStore.prototype.get = function(value) {
    if (value === key && ['categoryNotes', 'categoryNoteBackups'].includes(this.name)) {
      reads.push(this.name); if (this.name === 'categoryNoteBackups') throw new Error('unavailable recovery store');
    }
    return get.call(this, value);
  };
  try { assert.equal(await notes.loadCategoryNoteRaw(key), raw); }
  finally { IDBObjectStore.prototype.get = get; }
  assert.deepEqual(reads, ['categoryNotes']);
});

test('newer durable legacy content still wins over a valid current note without consulting recovery', async () => {
  const newer = JSON.stringify({ dataUrl: 'legacy latest', updatedAt: '2026-10-15T00:00:00Z' });
  accountLocalStorage.setItem(key, newer);
  try { assert.equal(await notes.loadCategoryNoteRaw(key), newer); }
  finally { accountLocalStorage.removeItem(key); }
});

test('missing and corrupt projections reconstruct the canonical record without changing revision or outbox', async () => {
  const read=async(store,id)=>{const tx=db.transaction(store),r=tx.objectStore(store).get(id);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});return r.result;};
  const recordKey=JSON.stringify(['indexedDbNotes',key]),before=await read('appRecords',recordKey),operation=await read('appOutbox',recordKey);
  await write('categoryNoteBackups', raw);
  for (const current of [null, '{broken']) {
    await write('categoryNotes', current);
    assert.equal(await notes.loadCategoryNoteRaw(key), raw);
    assert.equal((await read('categoryNotes',key)),raw);
    assert.deepEqual(await read('appRecords',recordKey),before);
    assert.deepEqual(await read('appOutbox',recordKey),operation);
  }
  await write('categoryNoteBackups', '{also broken');
  assert.equal(await notes.loadCategoryNoteRaw(key),raw);
  await write('categoryNotes', raw); await write('categoryNoteBackups', raw);
});

test('backup-only candidates cannot be edited or transmitted merely by opening them; explicit restore creates one edit',async()=>{
  const candidateKey='quizMake:notes:s:orphan',candidate=JSON.stringify({dataUrl:'rescued',updatedAt:'2020-01-01T00:00:00Z'});
  const tx=db.transaction('categoryNoteBackups','readwrite');tx.objectStore('categoryNoteBackups').put(candidate,candidateKey);
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
  for(let i=0;i<2;i++)await assert.rejects(notes.loadCategoryNoteRaw(candidateKey),error=>error instanceof notes.CategoryNoteRecoveryRequiredError&&error.candidate===candidate);
  assert.ok(notes.categoryNoteRecoveryKeys().includes(candidateKey));
  const {readRecordSyncStatus,recordSyncSummary}=await import('../src/utils/recordSyncStatus.ts');
  const {syncStatusPresentation}=await import('../src/utils/syncStatusPresentation.ts');
  const status=await readRecordSyncStatus(db,{project:'https://fixture.test',userId:'fixture',syncId:'fixture'});
  assert.equal(recordSyncSummary(status),'要復旧のノート1件');
  assert.equal(syncStatusPresentation({online:true,loginRequired:false,error:false,autoEnabled:true,recordEnabled:true,record:{...status,pending:0},pending:false,success:'2026-01-01'}).text,'要復旧のノート1件');
  await notes.restoreCategoryNoteCandidate(candidateKey,candidate);
  const restored=JSON.parse(await notes.loadCategoryNoteRaw(candidateKey));
  assert.equal(restored.dataUrl,'rescued');assert.notEqual(restored.updatedAt,'2020-01-01T00:00:00Z');
  assert.ok(!notes.categoryNoteRecoveryKeys().includes(candidateKey));
});

test('pre-sync repair resolves an old global marker from canonical records without requiring the note to be opened',async()=>{
  await write('categoryNotes',null);
  accountLocalStorage.setItem(notes.CATEGORY_NOTES_RECOVERY_REQUIRED_KEY,JSON.stringify({version:1,reason:'backup-only'}));
  await notes.repairCategoryNoteProjections();
  assert.equal(notes.isCategoryNotesRecoveryRequired(),false);
  const tx=db.transaction('categoryNotes'),saved=tx.objectStore('categoryNotes').get(key);
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
  assert.equal(saved.result,raw);
});

test('canonical tombstones do not revive an old backup or durable fallback',async()=>{
  const id='quizMake:notes:s:deleted',recordKey=JSON.stringify(['indexedDbNotes',id]);
  const tx=db.transaction(['categoryNoteBackups','appRecords'],'readwrite');
  tx.objectStore('categoryNoteBackups').put(raw,id);
  tx.objectStore('appRecords').put({key:recordKey,collection:'indexedDbNotes',id,raw:null,position:0,localRevision:1,serverRevision:1},recordKey);
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
  accountLocalStorage.setItem(id,raw);
  try{assert.equal(await notes.loadCategoryNoteRaw(id),null);}finally{accountLocalStorage.removeItem(id);}
});

test('an unreadable primary cannot turn into an older backup or empty editable canvas', async () => {
  const get = IDBObjectStore.prototype.get, warn = console.warn;
  console.warn = () => {};
  IDBObjectStore.prototype.get = function(value) {
    if (this.name === 'categoryNotes' && value === key) throw new Error('primary read failed');
    return get.call(this, value);
  };
  try { await assert.rejects(notes.loadCategoryNoteRaw(key), /Failed to read category note data/); }
  finally { IDBObjectStore.prototype.get = get; console.warn = warn; }
});
