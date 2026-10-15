import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){},length:0,key:()=>null};
const {storedValueBytes,readStorageBreakdown}=await import('../src/utils/storageBreakdown.ts');
test('payload estimates count UTF-8, binary blobs and nested record copies',()=>{
  assert.equal(storedValueBytes('あ'),3);for(const text of ['aあ😀','\ud800','\udc00','\r\n'])assert.equal(storedValueBytes(text),new Blob([text]).size);assert.equal(storedValueBytes(new Blob([new Uint8Array(1024)])),1024);
  assert.equal(storedValueBytes({raw:'abc'}),6);
});
test('audit reads only existing current-account databases without changing originals',async()=>{
  async function seed(name){const db=await new Promise((r,j)=>{const q=indexedDB.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('categoryNotes');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});const tx=db.transaction('categoryNotes','readwrite');tx.objectStore('categoryNotes').put('original','note');await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j;});db.close();}
  await seed('quiz-make-app-data-v1');await seed('quiz-make-notes-v1');await seed('unrelated-account');
  const before=await indexedDB.databases(),updates=[],rows=await readStorageBreakdown({onProgress:(rows,label)=>updates.push({rows,label})});
  assert.ok(updates.some(item=>item.label));assert.ok(updates.some(item=>item.rows.some(row=>row.bytes>0)));
  const controller=new AbortController();controller.abort();await assert.rejects(readStorageBreakdown({signal:controller.signal}));
  assert.equal(rows.length,2);assert.equal(rows.reduce((n,r)=>n+r.bytes,0),16);assert.ok(rows.some(r=>r.label.startsWith('移行前')));
  assert.deepEqual(await indexedDB.databases(),before);assert.deepEqual(await readStorageBreakdown(),rows);
});
