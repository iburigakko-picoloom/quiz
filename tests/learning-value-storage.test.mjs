import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { upgradeAppRecordStores, appRecordKey } from '../src/utils/appRecordStorage.ts';
import { migrateLearningStorage, prepareLearningValue, queueLearningValue, readLearningValues } from '../src/utils/learningValueStorage.ts';
import { LEARNING_REQUIRED_ROW } from '../src/utils/learningStorageKeys.ts';
import { accountLocalStorage, AccountStorageSession, activateAccountStorage, decideAccountStorage } from '../src/utils/accountStorage.ts';
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.window = { dispatchEvent() {} };
const key = 'quiz-make-creation-notes-v1';
function memory({ denyRemove = false, denyWrite = false } = {}) {
  const values = new Map(); return { values, get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null, setItem(k, v) { if (denyWrite) throw new DOMException('full', 'QuotaExceededError'); values.set(k, String(v)); },
    removeItem(k) { if (denyRemove) throw new Error('cleanup denied'); values.delete(k); } };
}
async function fixture(options) {
  globalThis.localStorage = memory(options); const factory = new IDBFactory(); globalThis.indexedDB = factory;
  const db = await new Promise((resolve, reject) => { const r = factory.open('migration', 7); r.onupgradeneeded = () => { upgradeAppRecordStores(r.result); r.result.createObjectStore('appDataBackups'); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return { db, native: globalThis.localStorage };
}
async function transaction(db, stores, callback) { const tx = db.transaction(stores, 'readwrite'); callback(tx); await new Promise((r,j) => { tx.oncomplete = r; tx.onabort = () => j(tx.error); }); }
async function rows(db, store) { const tx = db.transaction(store), r = tx.objectStore(store).getAll(); await new Promise((resolve,reject) => { tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error); }); return r.result; }
async function canonical(db, raw, pending = true) { await transaction(db, ['appRecords','localProjections','appOutbox'], tx => { const record = { key: appRecordKey('localStorage',key), collection:'localStorage',id:key,raw,position:0,localRevision:9,serverRevision:2 };tx.objectStore('appRecords').put(record,record.key);tx.objectStore('appOutbox').put({...record,operationId:'unchanged-operation'},record.key);if(pending)tx.objectStore('localProjections').put(raw,key); }); }
test('native-only learning text is verified, archived exactly and hydrated without a required native cache', async () => {
  const {db,native} = await fixture(); const raw='[{"id":"original","body":"'+ '日本語'.repeat(30000) +'"}]'; native.setItem(key,raw);
  await migrateLearningStorage(db); assert.equal(native.getItem(key),null);assert.equal(accountLocalStorage.getItem(key),raw);
  const {publishedReplay}=await import('./fixtures/published-projection-replay.mjs');
  await assert.rejects(publishedReplay(db,native),/保存済みメモ/);assert.equal(accountLocalStorage.getItem(key),raw);
  assert.equal((await readLearningValues(db)).get(key).raw,raw);assert.equal((await rows(db,'appDataBackups'))[0].raw,raw);
  assert.equal((await rows(db,'appOutbox')).length,0);await migrateLearningStorage(db);assert.equal((await rows(db,'appDataBackups')).length,1);db.close();
});
test('a saved pending attempt replaces its old native cache without changing outbox IDs or losing the original', async () => {
  const {db,native}=await fixture(),old='[{"id":"old"}]',next='[{"id":"saved"}]';native.setItem(key,old);await canonical(db,next);const outbox=await rows(db,'appOutbox');
  await migrateLearningStorage(db);assert.equal(accountLocalStorage.getItem(key),next);assert.deepEqual(await rows(db,'appOutbox'),outbox);assert.deepEqual(await rows(db,'localProjections'),[LEARNING_REQUIRED_ROW]);
  assert.equal((await rows(db,'appDataBackups'))[0].raw,old);db.close();
});
test('interrupted original archival preserves the native copy and saved outbox, and retry is idempotent', async () => {
  const {db,native}=await fixture(),old='[{"id":"old"}]',next='[{"id":"next"}]';native.setItem(key,old);await canonical(db,next);const outbox=await rows(db,'appOutbox'),original=db.transaction.bind(db);
  db.transaction=(stores,...args)=>{const tx=original(stores,...args);if(stores==='appDataBackups'&&args[0]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
  await assert.rejects(migrateLearningStorage(db));assert.equal(native.getItem(key),old);assert.deepEqual(await rows(db,'appOutbox'),outbox);assert.equal((await rows(db,'localProjections'))[0],next);
  db.transaction=original;await migrateLearningStorage(db);assert.equal(accountLocalStorage.getItem(key),next);db.close();
});
test('failed native cleanup keeps a durable restart marker and retries without confusing the retained old cache with a new edit', async () => {
  const {db,native}=await fixture({denyRemove:true}),old='[{"id":"old"}]',next='[{"id":"new"}]';native.setItem(key,old);await canonical(db,next);await migrateLearningStorage(db);
  assert.equal(native.getItem(key),old);assert.equal(accountLocalStorage.getItem(key),next);assert.match((await readLearningValues(db)).get(key).nativeCleanup,/^[a-f0-9]{64}$/);
  globalThis.localStorage={...native,removeItem:k=>native.values.delete(k)};await migrateLearningStorage(db);assert.equal(native.getItem(key),null);assert.equal((await readLearningValues(db)).get(key).nativeCleanup,undefined);db.close();
});
test('ambiguous or corrupt values stop migration before deleting either original', async () => {
  const {db,native}=await fixture();native.setItem(key,'[{"id":"native"}]');await canonical(db,'[{"id":"record"}]',false);await assert.rejects(migrateLearningStorage(db),/異なります/);assert.equal(native.getItem(key),'[{"id":"native"}]');
  const value=await prepareLearningValue(key,'[{"id":"view"}]');await transaction(db,['appData'],tx=>queueLearningValue(tx,{...value,sha256:'bad'}));await assert.rejects(migrateLearningStorage(db),/照合/);assert.equal(native.getItem(key),'[{"id":"native"}]');db.close();
});
test('a canonical write during migration aborts its commit and retains the newer pending attempt', async () => {
  const {db,native}=await fixture(),old='[{"id":"old"}]',saved='[{"id":"saved"}]',newer='[{"id":"peer"}]';native.setItem(key,old);await canonical(db,saved);const original=db.transaction.bind(db);let injected=false;
  db.transaction=(stores,...args)=>{if(!injected&&Array.isArray(stores)&&stores.join(',')==='appData,appRecords,localProjections'&&args[0]==='readwrite'){injected=true;const tx=original(['appRecords','localProjections'],'readwrite');tx.objectStore('appRecords').put({key:appRecordKey('localStorage',key),collection:'localStorage',id:key,raw:newer,position:0},appRecordKey('localStorage',key));tx.objectStore('localProjections').put(newer,key);}return original(stores,...args);};
  await assert.rejects(migrateLearningStorage(db));assert.equal(native.getItem(key),old);assert.equal((await rows(db,'localProjections'))[0],newer);db.transaction=original;await migrateLearningStorage(db);assert.equal(accountLocalStorage.getItem(key),newer);db.close();
});
test('plan and memo saves work with native learning writes denied; capture, deletion and IDB outage retain correct durable intent', async () => {
  const native=memory();globalThis.localStorage=native;globalThis.indexedDB=new IDBFactory();
  const storage=await import('../src/storage.ts'),sync=await import('../src/utils/localStorageRecords.ts'),records=await import('../src/utils/appRecordStorage.ts');
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()),true);
  native.setItem(key,'[]');const remove=native.removeItem.bind(native);let denyCleanup=true;native.removeItem=k=>{if(denyCleanup&&k===key)throw Error('old cache cleanup denied');remove(k);};
  const raw='[{"id":"large","body":"'+'a'.repeat(1748479)+'"}]';const normal=native.setItem.bind(native);native.setItem=(k,v)=>{if(k===key||k==='quiz-make-explanation-requests-v1')throw new DOMException('full','QuotaExceededError');normal(k,v);};
  await sync.saveSyncedLocalStorage({[key]:raw});await sync.saveSyncedLocalStorage({'quiz-make-explanation-requests-v1':'[{"id":"independent"}]'});const db=await storage.openAppDb(),outbox=await records.readAppOutbox(db);
  assert.equal(native.getItem(key),'[]');assert.equal(accountLocalStorage.getItem(key),raw);assert.equal(await sync.captureSyncedLocalStorage(k=>k===key||k==='quiz-make-explanation-requests-v1'),0);assert.deepEqual(await records.readAppOutbox(db),outbox);
  denyCleanup=false;await sync.replayLocalStorageProjections();assert.equal(native.getItem(key),null);
  const factory=globalThis.indexedDB;globalThis.indexedDB=undefined;await assert.rejects(sync.saveSyncedLocalStorage({[key]:'[]'}),/IndexedDB/);assert.equal(accountLocalStorage.getItem(key),raw);globalThis.indexedDB=factory;
  globalThis.localStorage={...native,get length(){return native.values.size;}};globalThis.indexedDB=undefined;await assert.rejects(sync.replayLocalStorageProjections(),/IndexedDB/);await assert.rejects(sync.saveSyncedLocalStorage({[key]:'[]'}),/IndexedDB/);assert.equal(native.getItem(key),null);globalThis.localStorage=native;globalThis.indexedDB=factory;
  await sync.saveSyncedLocalStorage({[key]:null});assert.equal(accountLocalStorage.getItem(key),null);assert.equal((await records.readAppOutbox(db)).find(r=>r.id===key).raw,null);
  assert.equal(await sync.captureSyncedLocalStorage(k=>k===key||k==='quiz-make-explanation-requests-v1'),0);
});
test('an unrelated failed small projection cannot block a durable learning save', async () => {
  const storage=await import('../src/storage.ts'),sync=await import('../src/utils/localStorageRecords.ts'),db=await storage.openAppDb();
  await transaction(db,['localProjections'],tx=>tx.objectStore('localProjections').put('pending','quizMake:denied-small'));
  const normal=globalThis.localStorage.setItem.bind(globalThis.localStorage);globalThis.localStorage.setItem=(k,v)=>{if(k==='quizMake:denied-small')throw Error('small cache denied');normal(k,v);};
  await sync.saveSyncedLocalStorage({[key]:'[{"id":"saved-after-unrelated-failure"}]'});assert.equal(accountLocalStorage.getItem(key),'[{"id":"saved-after-unrelated-failure"}]');assert.ok((await rows(db,'localProjections')).includes('pending'));
});
test('account fencing during verification prevents late archive writes and native cleanup', async () => {
  const {db,native}=await fixture();native.setItem(key,'[{"id":"original"}]');const owner=new AccountStorageSession(native,decideAccountStorage(native,null,null));activateAccountStorage(owner);
  const promise=migrateLearningStorage(db);owner.invalidate();await assert.rejects(promise,/アカウント/);assert.equal(native.getItem(key),'[{"id":"original"}]');assert.deepEqual(await rows(db,'appDataBackups'),[]);db.close();
});
