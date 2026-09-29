import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
const hook=registerHooks({resolve(specifier,context,next){return next(/^\.\.?\//u.test(specifier)&&!/\.[cm]?[jt]sx?$/u.test(specifier)&&context.parentURL?.endsWith('.ts')?`${specifier}.ts`:specifier,context);}});
process.on('exit',()=>hook.deregister());
const {upgradeAppRecordStores,saveAppRecords,readAppOutbox,appRecordKey}=await import('../src/utils/appRecordStorage.ts');
const {queueNoteRecordWrite,NOTE_RECORD_TRANSACTION_STORES}=await import('../src/utils/auxiliaryRecordStorage.ts');
const {prepareRecordMaterialOutbox}=await import('../src/utils/recordMaterialSync.ts');
const {hydrateMaterialDownload}=await import('../src/utils/materialCloud.ts');
const timestamp='2026-09-29T00:00:00Z';
const key='quizMake:notes:set:__material_pdf_pdf';
const bytes=Buffer.from('fake PDF bytes for protocol verification');
const dataUrl='data:application/pdf;base64,'+bytes.toString('base64');
async function db(){const factory=new IDBFactory();return new Promise((resolve,reject)=>{const req=factory.open('records',6);req.onupgradeneeded=()=>upgradeAppRecordStores(req.result);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
async function get(database,store,key){const tx=database.transaction(store);const finish=done(tx);const req=tx.objectStore(store).get(key);await finish;return req.result;}
test('PDF upload is independent of question Outbox and keeps the local bytes for recovery',async()=>{
  const database=await db();
  try{
    await saveAppRecords(database,{version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]},timestamp);
    const local=JSON.stringify({kind:'quiz-material-file',version:1,materialId:'pdf',updatedAt:timestamp,dataUrl});
    const tx=database.transaction(NOTE_RECORD_TRANSACTION_STORES,'readwrite');const finish=done(tx);
    tx.objectStore('categoryNotes').put(local,key);queueNoteRecordWrite(tx,key,local);await finish;
    let uploads=0,downloads=0;
    const transport={userId:'11111111-1111-1111-1111-111111111111',cacheScope:'test',exists:async()=>false,
      async upload(remote,uploaded){uploads++;assert.deepEqual(Buffer.from(uploaded),bytes);assert.equal(remote.size,bytes.length);},
      async download(remote){downloads++;assert.equal(remote.size,bytes.length);return Uint8Array.from(bytes);}};
    const prepared=await prepareRecordMaterialOutbox(database,transport,async()=>{});
    assert.deepEqual(prepared,{prepared:1,more:false});
    assert.equal(uploads,1);
    const op=(await readAppOutbox(database)).find(item=>item.id===key);
    assert.equal(JSON.parse(op.raw).kind,'quiz-material-remote-file');
    assert.ok(op.raw.length<400);
    assert.equal((await get(database,'appRecords',appRecordKey('indexedDbNotes',key))).raw,op.raw);
    assert.equal(await get(database,'categoryNotes',key),local);
    assert.deepEqual(await prepareRecordMaterialOutbox(database,transport,async()=>{}),{prepared:0,more:false});
    assert.equal(uploads,1);
    const hydrated=await hydrateMaterialDownload({version:1,updatedAt:timestamp,localStorage:{},indexedDbNotes:{[key]:op.raw}},transport);
    assert.equal(hydrated.indexedDbNotes[key],local);
    assert.equal(downloads,1);
  }finally{database.close();}
});
