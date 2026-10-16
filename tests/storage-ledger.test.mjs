import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const {installStorageLedger,initializeStorageLedger}=await import('../src/utils/storageLedger.ts');
const {idbDone,idbResult}=await import('../src/utils/blobVault.ts');
const db=await new Promise((r,j)=>{const q=indexedDB.open('ledger',1);q.onupgradeneeded=()=>{q.result.createObjectStore('values');q.result.createObjectStore('storageLedger');};q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});after(()=>db.close());
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
