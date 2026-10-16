import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
globalThis.window={dispatchEvent(){}};
Object.defineProperty(navigator,'locks',{value:{request:async(_n,_o,run)=>run()},configurable:true});
const {saveBackupPayloadReference,verifySavedBackupReference,getSavedBackup,listSavedBackups,saveBackupOriginals}=await import('../src/utils/backupRepository.ts');
const {enforceBackupHistoryLimit,listBackupHistory,BACKUP_HISTORY_LIMIT,automaticHistoryDeletions,settleAutomaticBackupHistory}=await import('../src/utils/backupHistory.ts');
const {createCompleteFileBackup,validateFileBackup}=await import('../src/utils/backupPayload.ts');
const {saveAppDataAsync,loadAppDataAsync,openAppDb}=await import('../src/storage.ts');
const {jsonBackupBlob,hashBackupBlob}=await import('../src/utils/incrementalJsonDigest.ts');
const stamp='2026-10-12T00:00:00Z';
const data={version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]};
await saveAppDataAsync(data);const app=await openAppDb();after(()=>app.close());
const open=version=>new Promise((resolve,reject)=>{const r=indexedDB.open('quiz-make-backups',version);r.onupgradeneeded=()=>r.result.createObjectStore('backups',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
const payload=()=>createCompleteFileBackup({version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(data)},indexedDbNotes:{}},[]);

test('opening and retrying history preserves every unknown legacy original without reading bodies',async()=>{
  const db=await open(1),tx=db.transaction('backups','readwrite');
  for(let i=0;i<12;i++)tx.objectStore('backups').add({id:'old-'+i,createdAt:new Date(Date.parse(stamp)+i*1000).toISOString(),kind:'before-sync',raw:'legacy body '+i,byteSize:2**28,...(i===11?{format:'originals'}:{})});
  await done(tx);db.close();
  const get=IDBObjectStore.prototype.get,cursor=IDBObjectStore.prototype.openCursor;
  IDBObjectStore.prototype.get=function(...args){if(this.name==='backups')assert.fail('history must not read body');return get.apply(this,args)};
  IDBObjectStore.prototype.openCursor=function(...args){if(this.name==='backups')assert.fail('history must not clone bodies');return cursor.apply(this,args)};
  try{
    assert.equal((await listSavedBackups()).length,12);await enforceBackupHistoryLimit();
    const rows=await listBackupHistory();assert.equal(rows.length,12);assert.equal(rows[0].format,'originals');
    await enforceBackupHistoryLimit();assert.deepEqual(await listBackupHistory(),rows);
  }finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.openCursor=cursor}
  assert.deepEqual(await loadAppDataAsync(),data);
});

test('streamed backup saves and verifies exact bytes without a full string read; legacy file export still works',async()=>{
  const file=await payload(),text=Blob.prototype.text;
  Blob.prototype.text=async()=>assert.fail('sync verification must not read the entire Blob');
  let ref;try{ref=await saveBackupPayloadReference(file,'before-sync');assert.equal(await verifySavedBackupReference(ref),true)}finally{Blob.prototype.text=text}
  assert.deepEqual(await saveBackupPayloadReference(file,'before-sync'),ref,'retry reuses the same verified original without increasing history');
  const saved=await getSavedBackup(ref.id);assert.deepEqual(JSON.parse(saved.raw),file);assert.equal((await validateFileBackup(JSON.parse(saved.raw))).ok,true);
  assert.equal((await listBackupHistory()).length,13);
  assert.equal(await verifySavedBackupReference({...ref,digest:'0'.repeat(64)}),false);
  assert.equal(await verifySavedBackupReference({...ref,complete:false}),false);
  const db=await open(3),tx=db.transaction('backups','readwrite'),store=tx.objectStore('backups'),r=store.get(ref.id);r.onsuccess=()=>store.put({...r.result,raw:new Blob(['corrupt'])});await done(tx);db.close();
  assert.equal(await verifySavedBackupReference(ref),false);
});

test('retention counts only two distinct settled contents, excluding rescue, pending, manual and unknown originals',()=>{
  const row=(id,digest,extra={})=>({id,createdAt:stamp,kind:'before-sync',byteSize:100,contentDigest:digest.repeat(64),retentionState:'ready',...extra});
  const history=[row('new-a','a'),row('retry-a','a'),row('b','b'),row('c','c'),
    row('rescue','d',{format:'originals'}),row('partial','d',{format:'partial'}),row('pending','d',{retentionState:'pending'}),
    row('manual','e',{kind:'manual'}),{id:'unknown',createdAt:stamp,kind:'before-sync',byteSize:100}];
  assert.equal(BACKUP_HISTORY_LIMIT,2);
  assert.deepEqual(automaticHistoryDeletions(history).map(item=>item.id),['retry-a','c']);
});

test('failed new save and invalid files do not authorize pruning',async()=>{
  const file=await payload(),before=await listBackupHistory();
  const add=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){if(this.name==='backups')throw new DOMException('full','QuotaExceededError');return add.apply(this,args)};
  try{await assert.rejects(saveBackupPayloadReference(file,'before-sync'),/full/)}finally{IDBObjectStore.prototype.add=add}
  await assert.rejects(saveBackupPayloadReference({...file,backupManifest:{...file.backupManifest,contentDigest:'0'.repeat(64)}},'before-sync'));
  assert.deepEqual(await listBackupHistory(),before);
});

test('byte stream remains identical to JSON serialization including surrogate and chunk boundaries',async()=>{
  const value={a:'x'.repeat(16383)+'😀'+'y'.repeat(300000)+'\ud800',b:[null,3,'日本語']};
  const saved=await jsonBackupBlob(value);assert.equal(await saved.blob.text(),JSON.stringify(value));assert.equal(await hashBackupBlob(saved.blob),saved.digest);
});

test('account change during read-back rejects the witness and cannot prune another account',async()=>{
  const file=await payload(),native=globalThis.localStorage,read=Blob.prototype.arrayBuffer;
  let switched=false;Blob.prototype.arrayBuffer=async function(){if(!switched){switched=true;globalThis.localStorage={...native}}return read.call(this)};
  try{await assert.rejects(saveBackupPayloadReference(file,'before-sync'),/保存先/)}finally{Blob.prototype.arrayBuffer=read;globalThis.localStorage=native}
});

test('uncertain sends preserve all witnesses; settlement trims only automatic history and keeps the oldest rescue original',async()=>{
  const rescue=await saveBackupOriginals('only rescue original');
  const manual=await saveBackupPayloadReference(await payload(),'manual');
  const witnesses=[];
  for(let i=0;i<3;i++){
    const state={...data,folders:[{id:'f',name:'Version '+i,createdAt:stamp,updatedAt:stamp}]};
    const file=await createCompleteFileBackup({version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(state)},indexedDbNotes:{}},[]);
    witnesses.push(await saveBackupPayloadReference(file,'before-sync'));
  }
  let tx=app.transaction('appRecordMeta','readwrite');tx.objectStore('appRecordMeta').put({id:'uncertain-operation'},'wholeFrozen');await done(tx);
  const pending=await listBackupHistory();await settleAutomaticBackupHistory();assert.deepEqual(await listBackupHistory(),pending);
  tx=app.transaction('appRecordMeta','readwrite');tx.objectStore('appRecordMeta').delete('wholeFrozen');await done(tx);
  await settleAutomaticBackupHistory();
  const settled=await listBackupHistory();
  assert.equal(settled.filter(row=>row.kind==='before-sync'&&row.retentionState==='ready').length,2);
  assert.equal((await getSavedBackup(rescue.id)).raw,'only rescue original');
  assert.ok(await getSavedBackup(manual.id));
  assert.equal(await getSavedBackup(witnesses[0].id),undefined);
  assert.ok(await getSavedBackup(witnesses[2].id));
});
