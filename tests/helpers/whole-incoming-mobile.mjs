import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {incomingFixture} from './whole-incoming-fixture.mjs';
globalThis.indexedDB=new IDBFactory();globalThis.localStorage={length:0,key:()=>null,getItem:()=>null};
const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('mobile',1);request.onupgradeneeded=()=>{request.result.createObjectStore('appPullMedia');request.result.createObjectStore('categoryNotes');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
try{
  const fixture=await incomingFixture({count:4,bytes:4*1024*1024});let active=0,maxActive=0;
  const original=fixture.transport.download;fixture.transport.download=async file=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));try{return await original(file);}finally{active--;}};
  const {buildWholeIncomingFile}=await import('../../src/utils/wholeSyncIncoming.ts');
  const file=await buildWholeIncomingFile(db,fixture.rows,fixture.transport,async()=>{});
  assert.equal(file.backupManifest.completeness,'complete');assert.equal(fixture.downloaded,4);assert.equal(maxActive,1);
  console.log(JSON.stringify({pdfs:4,bytesPerPdf:4*1024*1024,maxConcurrentDownloads:maxActive,heapLimitMiB:192}));
}finally{db.close();}
