import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
const hook=registerHooks({resolve(specifier,context,next){return next(/^\.\.?\//u.test(specifier)&&!/\.[cm]?[jt]sx?$/u.test(specifier)&&context.parentURL?.endsWith('.ts')?`${specifier}.ts`:specifier,context);}});
process.on('exit',()=>hook.deregister());
const values=new Map();
globalThis.localStorage={get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,
  setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
globalThis.window={dispatchEvent(){}};globalThis.indexedDB=new IDBFactory();
const storage=await import('../src/storage.ts');
const images=await import('../src/utils/questionImageRecords.ts');
const {readAppOutbox,appRecordKey}=await import('../src/utils/appRecordStorage.ts');
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error??new Error('aborted'));});
async function get(db,store,key){const tx=db.transaction(store);const finish=done(tx);const req=tx.objectStore(store).get(key);await finish;return req.result;}
test('existing images migrate with small metadata/Outbox, remain recoverable, and deletion leaves a tombstone',async()=>{
  const blob=new Blob([Uint8Array.from([137,80,78,71,1,2,3])],{type:'image/png'});
  const original={id:'img',questionId:'q',name:'source.png',type:'image/png',blob,addedAt:'2026-09-29T00:00:00Z'};
  const old=await new Promise((resolve,reject)=>{const req=indexedDB.open('quiz-make-local-question-images-v1',1);
    req.onupgradeneeded=()=>{const s=req.result.createObjectStore('images',{keyPath:'id'});s.createIndex('questionId','questionId');};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  let tx=old.transaction('images','readwrite');let finish=done(tx);tx.objectStore('images').put(original);await finish;old.close();
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()),true);
  const db=await images.openQuestionImageRecordDb();
  const restored=await images.readQuestionImages('q',['img']);
  assert.equal(restored.length,1);assert.deepEqual(Buffer.from(await restored[0].blob.arrayBuffer()),Buffer.from(await blob.arrayBuffer()));
  const row=await get(db,'appRecords',appRecordKey('questionImages','img'));
  assert.equal(row.collection,'questionImages');assert.equal(JSON.parse(row.raw).id,'img');
  assert.ok(row.raw.length<400);assert.equal((await readAppOutbox(db)).find(op=>op.id==='img').raw,row.raw);
  const reopened=await new Promise((resolve,reject)=>{const req=indexedDB.open('quiz-make-local-question-images-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  assert.equal((await get(reopened,'images','img')).id,'img','original recovery copy stays intact');reopened.close();
  await images.removeQuestionImages(image=>image.id==='img');
  assert.equal((await images.readQuestionImages('q',['img'])).length,0);
  assert.equal((await get(db,'appRecords',appRecordKey('questionImages','img'))).raw,null);
  assert.equal((await readAppOutbox(db)).find(op=>op.id==='img').raw,null);
  db.close();
});
