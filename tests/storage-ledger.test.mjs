import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const {installStorageLedger,initializeStorageLedger,appendCheckpointStage,accountCheckpointRecords}=await import('../src/utils/storageLedger.ts');
const {idbDone,idbResult}=await import('../src/utils/blobVault.ts');
const db=await new Promise((r,j)=>{const q=indexedDB.open('ledger',1);q.onupgradeneeded=()=>{for(const name of ['values','storageLedger','deltaStage','appRecords','appRecordMeta'])q.result.createObjectStore(name);};q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});after(()=>db.close());
const put=async(value,key)=>{const tx=db.transaction('values','readwrite'),done=idbDone(tx);tx.objectStore('values').put(value,key);await done;};
const totals=async()=>{const tx=db.transaction('storageLedger'),done=idbDone(tx),value=await idbResult(tx.objectStore('storageLedger').get('summary'));await done;return value.values;};
test('bounded initialization and subsequent writes count changed values exactly without rereading bodies',async()=>{
  await put('before','a');await put(new Blob([new Uint8Array(1024)]),'b');installStorageLedger(db);
  await initializeStorageLedger(db,1);await put('あ','a');while(!await initializeStorageLedger(db,1)){}
  assert.deepEqual({...await totals(),after:undefined},{bytes:1027,count:2,complete:true,after:undefined});
  await put('new','a');assert.equal((await totals()).bytes,1027);
});
test('clear then replacement in one transaction and quota abort keep ledger atomic',async()=>{
  const tx=db.transaction('values','readwrite'),done=idbDone(tx);tx.objectStore('values').clear();tx.objectStore('values').put('12345','a');tx.objectStore('values').put('678','b');await done;
  assert.equal((await totals()).bytes,8);assert.equal((await totals()).count,2);
  const aborted=db.transaction('values','readwrite'),abortedDone=idbDone(aborted);aborted.objectStore('values').put('large','c');aborted.abort();await assert.rejects(abortedDone);
  assert.equal((await totals()).bytes,8);assert.equal((await totals()).count,2);
});
test('checkpoint batches keep exact totals, survive mixed metadata writes, and support later incremental edits',async()=>{
  const {storedValueBytes}=await import('../src/utils/storageBreakdown.ts');
  const rows=Array.from({length:200},(_,i)=>({key:'k'+i,raw:'本文'+i}));
  const tx=db.transaction(['deltaStage','appRecordMeta'],'readwrite'),done=idbDone(tx);
  appendCheckpointStage(tx,rows);tx.objectStore('appRecordMeta').put({received:rows.length},'deltaCheckpoint');await done;
  const summary=async()=>{const t=db.transaction('storageLedger'),d=idbDone(t),v=await idbResult(t.objectStore('storageLedger').get('summary'));await d;return v;};
  assert.deepEqual((await summary()).deltaStage,{bytes:rows.reduce((s,r)=>s+storedValueBytes(r),0),count:200,complete:true});
  const write=db.transaction(['appRecords','appRecordMeta'],'readwrite'),written=idbDone(write);accountCheckpointRecords(write,rows);for(const row of rows)write.objectStore('appRecords').put(row,row.key);write.objectStore('appRecordMeta').put({revision:1},'state');await written;
  const changed={...rows[0],raw:'new'};const edit=db.transaction('appRecords','readwrite'),edited=idbDone(edit);edit.objectStore('appRecords').put(changed,changed.key);await edited;
  assert.deepEqual((await summary()).appRecords,{bytes:rows.reduce((s,r)=>s+storedValueBytes(r),0)-storedValueBytes(rows[0])+storedValueBytes(changed),count:200,complete:true});
  const aborted=db.transaction(['deltaStage','appRecordMeta'],'readwrite'),failed=idbDone(aborted);appendCheckpointStage(aborted,[{key:'new',raw:'never committed'}]);aborted.abort();await assert.rejects(failed);assert.equal((await summary()).deltaStage.count,200);
  const clear=db.transaction('deltaStage','readwrite'),cleared=idbDone(clear);clear.objectStore('deltaStage').clear();await cleared;assert.deepEqual((await summary()).deltaStage,{bytes:0,count:0,complete:true});
});
