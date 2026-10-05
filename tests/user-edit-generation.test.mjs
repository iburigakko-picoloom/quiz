import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
globalThis.window={dispatchEvent(){}};
const storage=await import('../src/storage.ts');
const {readUserEditGeneration,queueUserEditGeneration}=await import('../src/utils/userEditGeneration.ts');
const {freezeRecordPushBatch,acknowledgeRecordPushBatch}=await import('../src/utils/recordSyncOutbox.ts');
const {stageRecordPullPage,applyStagedRecordPull}=await import('../src/utils/recordSyncPull.ts');
const {saveSyncedLocalStorage}=await import('../src/utils/localStorageRecords.ts');
const {prepareRecordChunks}=await import('../src/utils/recordChunks.ts');
const stamp='2026-10-05T00:00:00Z',folder={id:'f',name:'F',createdAt:stamp,updatedAt:stamp};
const data={version:1,folders:[folder],problemSets:[],questions:[],progress:[],answerLogs:[]};
assert.equal(await storage.saveAppDataAsync(data),true);const db=await storage.openAppDb();after(()=>db.close());
const connection={project:'https://generation.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:'1'.repeat(36)};
test('actual app edits advance once; unchanged saves and abandoned transactions do not',async()=>{
  const before=await readUserEditGeneration(db);assert.equal(before,1);
  assert.equal(await storage.saveAppDataAsync(data),true);assert.equal(await readUserEditGeneration(db),before);
  const tx=db.transaction('appRecordMeta','readwrite'),done=new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});queueUserEditGeneration(tx);queueUserEditGeneration(tx);tx.abort();await assert.rejects(done);assert.equal(await readUserEditGeneration(db),before);
});
test('acknowledgements and incoming changes never masquerade as new local user edits',async()=>{
  const before=await readUserEditGeneration(db),batch=await freezeRecordPushBatch(db,connection);
  await acknowledgeRecordPushBatch(db,batch,{code:'ok',revision:1,ack:batch.operations.map(op=>({operationId:op.operationId,key:op.key,revision:1}))});
  assert.equal(await readUserEditGeneration(db),before);
  const row=name=>({key:JSON.stringify(['folders','f']),collection:'folders',id:'f',raw:JSON.stringify({...folder,name}),position:0});
  await stageRecordPullPage(db,connection,0,{code:'ok',cursor:1,head:1,hasMore:false,batches:[{revision:1,changes:[{...row('F'),revision:1}]}]});
  assert.equal((await applyStagedRecordPull(db,connection)).applied,true);
  await stageRecordPullPage(db,connection,1,{code:'ok',cursor:2,head:2,hasMore:false,batches:[{revision:2,changes:[{...row('cloud edit'),revision:2}]}]});
  assert.equal((await applyStagedRecordPull(db,connection)).applied,true);assert.equal(await readUserEditGeneration(db),before);
  assert.equal((await storage.loadAppDataAsync()).folders[0].name,'cloud edit');
});
test('user memo changes advance one generation per transaction; chunk transport and no-op writes leave it stable',async()=>{
  const before=await readUserEditGeneration(db),raw=JSON.stringify([{id:'memo',title:'memo',body:'x'.repeat(1000000)}]);
  await saveSyncedLocalStorage({'quiz-make-creation-notes-v1':raw,'quiz-make-explanation-requests-v1':'[]'});
  assert.equal(await readUserEditGeneration(db),before+1);
  await saveSyncedLocalStorage({'quiz-make-creation-notes-v1':raw});assert.equal(await readUserEditGeneration(db),before+1);
  await prepareRecordChunks(db,connection);assert.equal(await readUserEditGeneration(db),before+1);
});
