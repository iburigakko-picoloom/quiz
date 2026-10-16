import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};globalThis.window={dispatchEvent(){}};
const vault=await import('../src/utils/blobVault.ts'),records=await import('../src/utils/appRecordStorage.ts'),migration=await import('../src/utils/blobArchiveMigration.ts');
const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('archives',1);r.onupgradeneeded=()=>{records.upgradeAppRecordStores(r.result);r.result.createObjectStore('appDataBackups');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});after(()=>db.close());
const read=async(store,key)=>{const tx=db.transaction(store),done=vault.idbDone(tx),value=await vault.idbResult(tx.objectStore(store).get(key));await done;return value;};
const raw=version=>JSON.stringify({version,dataUrl:'data:image/png;base64,YWJj'});
test('archive quota failure and owner change keep exact originals; retry verifies all bytes before advancing',async()=>{
  const tx=db.transaction('appDataBackups','readwrite'),done=vault.idbDone(tx);tx.objectStore('appDataBackups').put(raw(1),'a-rescue');await done;
  const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='appDataBackups')throw new DOMException('quota','QuotaExceededError');return put.apply(this,args);};
  try{await assert.rejects(migration.migrateArchiveBlobs(db,async()=>{}));}finally{IDBObjectStore.prototype.put=put;}
  assert.equal(await read('appDataBackups','a-rescue'),raw(1));assert.equal(await vault.readMeta(db,'archiveBlobMigration'),undefined);
  await assert.rejects(migration.migrateArchiveBlobs(db,async()=>{throw Error('owner changed')}),/owner changed/);assert.equal(await read('appDataBackups','a-rescue'),raw(1));
  await migration.migrateArchiveBlobs(db,async()=>{});const stored=await read('appDataBackups','a-rescue');assert.equal(await vault.unpackBlobNote(db,await stored.text()),raw(1));assert.equal((await vault.readMeta(db,'archiveBlobMigration')).after,'a-rescue');
});
test('old note current and backup versions are each verified and protected before source deletion',async()=>{
  const legacy=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiz-make-notes-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('categoryNotes');r.result.createObjectStore('categoryNoteBackups');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const tx=legacy.transaction(['categoryNotes','categoryNoteBackups'],'readwrite'),done=vault.idbDone(tx);tx.objectStore('categoryNotes').put(raw(2),'note');tx.objectStore('categoryNoteBackups').put(raw(1),'note');await done;legacy.close();await vault.writeMeta(db,'notesMigrationV1',1);
  await assert.rejects(migration.migrateLegacyBlobSources(db,async()=>{throw Error('account changed')}),/account changed/);
  await migration.migrateLegacyBlobSources(db,async()=>{});
  for(const [store,version] of [['categoryNotes',2],['categoryNoteBackups',1]]){const id=`legacy-original:quiz-make-notes-v1:${store}:note`;assert.equal(await vault.unpackBlobNote(db,await read('appDataBackups',id)),raw(version));assert.equal((await read('contentBlobRefs',`checkpoint:${id}`)).protect,true);}
  assert.equal(await migration.migrateLegacyBlobSources(db,async()=>{}),true);
});
