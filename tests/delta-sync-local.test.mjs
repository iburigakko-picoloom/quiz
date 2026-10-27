import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map(); globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.window = { dispatchEvent() {}, location:{href:'https://example.invalid/'}, addEventListener(){}, removeEventListener(){} };
const records = await import('../src/utils/appRecordStorage.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const { freezeDelta, sendDelta, applyDeltaRows, runDeltaSync } = await import('../src/utils/deltaSync.ts');
const { idbDone, idbResult, readMeta } = await import('../src/utils/blobVault.ts');
const dbs = []; after(() => dbs.forEach(db => db.close()));
const connection = { userId: 'account-a', project: 'https://example.supabase.co', syncId: 'a'.repeat(36) };
async function database() {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(crypto.randomUUID(), 1); r.onupgradeneeded = () => {records.upgradeAppRecordStores(r.result);r.result.createObjectStore('appDataBackups');}; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); dbs.push(db);
  const data = normalizeAppData({ version: 1, folders: [{ id: 'f', name: 'Folder', createdAt: '2026-10-15T00:00:00Z' }], problemSets: [], questions: [], progress: [], answerLogs: [] }).data;
  await records.saveAppRecords(db, data, new Date().toISOString());
  return { db, data };
}
const read = async (db, store, key) => { const tx = db.transaction(store), done = idbDone(tx); const result = await idbResult(tx.objectStore(store).get(key)); await done; return result; };

test('acknowledged upload echoes advance the cursor without changing live data or sending again', async () => {
  const { db } = await database(), { writeMeta } = await import('../src/utils/blobVault.ts');
  await writeMeta(db, 'deltaCursor', { connection, revision: 0 });
  const original = await read(db, 'appRecords', '["folders","f"]');
  const value = JSON.parse(original.raw);
  // PostgreSQL JSONB changes key order and whitespace in its response.
  const echoed = { key: original.key, collection: 'folders', id: 'f', position: original.position,
    raw: JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 1), revision: 1 };
  let pushes = 0, inspections = 0;
  const transport = { async delta(action, body) {
    if (action === 'receipt') return { code: 'ok', state: 'absent' };
    if (action === 'push') { pushes++; return { code: 'ok', state: 'committed', revision: 1 }; }
    assert.equal(action, 'pull');
    return { code: 'ok', revision: 1, head: 1, complete: true, fragment: body.revision === 0 ? JSON.stringify([echoed]) : '' };
  } };
  const guards = { assertCurrent: async () => {}, apply: async operation => {
    inspections++;
    const result = await operation({ preserveLiveData: true });
    assert.equal(result.applied, true); assert.equal(result.changed, 0);
    return result;
  } };
  assert.equal((await runDeltaSync(db, connection, transport, guards)).status, 'done');
  const state = await readMeta(db, 'state');
  for (let n = 0; n < 3; n++) assert.equal((await runDeltaSync(db, connection, transport, guards)).status, 'done');
  assert.equal(pushes, 1); assert.equal(inspections, 1);
  assert.equal((await readMeta(db, 'state')).commitId, state.commitId);
  assert.equal((await read(db, 'appRecords', original.key)).raw, original.raw);
  assert.equal((await read(db, 'appRecords', original.key)).serverRevision, 1);
  assert.equal((await readMeta(db, 'deltaCursor')).revision, 1);
  assert.equal(await freezeDelta(db, connection, 'device-a'), undefined);
});

test('inspection defers real cloud edits without losing pending local edits or advancing the cursor', async () => {
  const { db } = await database();
  const original = await read(db, 'appRecords', '["folders","f"]');
  const row = { key: original.key, collection: 'folders', id: 'f', raw: JSON.stringify({ ...JSON.parse(original.raw), name: 'Cloud edit' }), position: 0, revision: 3 };
  // Pending local work wins until sent, even on a protected screen.
  assert.equal((await applyDeltaRows(db, connection, [row], 3, { preserveLiveData: true })).changed, 0);
  assert.equal((await read(db, 'appOutbox', original.key)).raw, original.raw);
  const tx = db.transaction('appOutbox', 'readwrite'), done = idbDone(tx); tx.objectStore('appOutbox').clear(); await done;
  const state = await readMeta(db, 'state');
  assert.equal((await applyDeltaRows(db, connection, [{ ...row, revision: 4 }], 4, { preserveLiveData: true })).deferred, true);
  assert.equal((await readMeta(db, 'deltaCursor')).revision, 3);
  assert.equal((await readMeta(db, 'state')).commitId, state.commitId);
  const applied = await applyDeltaRows(db, connection, [{ ...row, revision: 4 }], 4);
  assert.equal(applied.changed, 1); assert.equal(applied.data.folders[0].name, 'Cloud edit');
});

test('an existing large frozen send resumes server-confirmed parts after lost replies and reload',async()=>{
  const {db}=await database();const frozen=await freezeDelta(db,connection,'device-a');
  // Keep an already-frozen old 24,000-character layout; never repartition it.
  frozen.parts=Array.from({length:434},(_,i)=>'exact old part '+i);
  const {writeMeta}=await import('../src/utils/blobVault.ts');await writeMeta(db,'deltaFrozen',frozen);
  let committed=false;const pushes=[],progress=[];const accepted=new Set(Array.from({length:432},(_,i)=>i));
  const transport={async delta(action,body){
    if(action==='receipt')return {code:'ok',state:committed?'committed':'staging',revision:committed?9:null,digest:frozen.digest,parts:434,deviceId:frozen.deviceId,sequence:frozen.sequence,received:[...accepted]};
    pushes.push(body.part);assert.equal(body.operationId,frozen.operationId);assert.equal(body.payload,frozen.parts[body.part]);accepted.add(body.part);
    if(body.part===432)throw Error('response lost after durable staging');
    committed=true;throw Error('response lost after commit');
  }};
  await assert.rejects(sendDelta(db,transport,frozen,async()=>{},p=>progress.push(p)),/durable staging/);
  assert.deepEqual(await readMeta(db,'deltaFrozen'),frozen);assert.equal(progress[0].completed,432);
  const reopened=await new Promise(resolve=>{const r=indexedDB.open(db.name);r.onsuccess=()=>resolve(r.result);});dbs.push(reopened);
  await assert.rejects(sendDelta(reopened,transport,await freezeDelta(reopened,connection,'device-a'),async()=>{}),/after commit/);
  await sendDelta(reopened,transport,frozen,async()=>{});
  assert.deepEqual(pushes,[432,433]);assert.equal(await readMeta(db,'deltaFrozen'),undefined);assert.equal(await read(db,'appOutbox',frozen.operations[0].key),undefined);
});

test('resume rejects mismatched or invalid receipts without deleting the frozen original',async()=>{
  const {db}=await database(),frozen=await freezeDelta(db,connection,'device-a');
  const base={code:'ok',state:'staging',digest:frozen.digest,parts:frozen.parts.length,deviceId:frozen.deviceId,sequence:frozen.sequence};
  for(const extra of [{digest:'different',received:[]},{received:[-1]},{received:[frozen.parts.length]}]){
    await assert.rejects(sendDelta(db,{delta:async(action)=>{assert.equal(action,'receipt');return {...base,...extra};}},frozen,async()=>{}),e=>e.code==='invalid_response');
    assert.deepEqual(await readMeta(db,'deltaFrozen'),frozen);
  }
});

test('completed legacy checkpoint waits without redownloading or reading bodies and resumes after reload',async()=>{
  const {db}=await database(),local=await read(db,'appOutbox','["folders","f"]');
  const row={key:local.key,collection:local.collection,id:local.id,raw:JSON.stringify({...JSON.parse(local.raw),name:'Legacy cloud'}),position:0,revision:8};
  let requests=0,mode='blocked',bodyReads=0;
  const progress=[],getAll=IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll=function(...args){if(this.name==='deltaStage')bodyReads++;return getAll.apply(this,args);};
  const transport={async delta(action){assert.equal(action,'checkpoint');requests++;return {code:'ok',revision:8,after:row.key,offset:0,rows:[{key:row.key,fragment:JSON.stringify(row),complete:true}],complete:true};}};
  const guards={assertCurrent:async()=>{},progress:p=>progress.push(p),apply:async op=>mode==='blocked'?null:op({preserveLiveData:mode==='editing'})};
  try{
    assert.equal((await runDeltaSync(db,connection,transport,guards,true)).status,'deferred');
    assert.equal((await readMeta(db,'deltaCheckpoint')).complete,true);assert.equal(await readMeta(db,'deltaCursor'),undefined);
    mode='editing';assert.equal((await runDeltaSync(db,connection,transport,guards,true)).status,'deferred');
    assert.equal(requests,1);assert.equal(bodyReads,0);assert.equal((await read(db,'appOutbox',local.key)).raw,local.raw);
    const reopened=await new Promise((resolve,reject)=>{const r=indexedDB.open(db.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});dbs.push(reopened);
    mode='ready';assert.equal((await runDeltaSync(reopened,connection,transport,guards,true)).status,'done');
    assert.equal(requests,1);assert.equal(bodyReads,1);assert.equal((await readMeta(reopened,'deltaCursor')).revision,8);assert.equal(await readMeta(reopened,'deltaCheckpoint'),undefined);
    assert.equal((await read(reopened,'appRecordConflicts',`legacy:${local.operationId}`)).local.raw,local.raw);
    assert.equal(JSON.parse((await read(reopened,'appRecords',local.key)).raw).name,'Legacy cloud');
    assert.ok(progress.some(p=>p.stage==='receiving_records'&&p.completed===1&&p.total===1));assert.ok(progress.some(p=>p.stage==='applying'&&p.completed===1));
  }finally{IDBObjectStore.prototype.getAll=getAll;}
});

test('legacy completed marker without complete flag upgrades once and a changed head restarts safely',async()=>{
  const {db}=await database(),{writeMeta}=await import('../src/utils/blobVault.ts');
  await writeMeta(db,'deltaCheckpoint',{connection,revision:3,after:'old-key',offset:0,fragment:''});
  let checkpoints=0,enables=0;
  const transport={async delta(action){
    if(action==='status')return {code:'ok',enabled:false,revision:4,sequence:0};
    if(action==='checkpoint'){checkpoints++;return {code:'ok',revision:checkpoints===1?3:4,after:'',offset:0,rows:[],complete:true};}
    assert.equal(action,'enable');return {code:++enables===1?'conflict':'ok'};
  },whole:async()=>assert.fail('no unresolved legacy send')};
  const {prepareDeltaSync}=await import('../src/utils/deltaMigration.ts'),guards={assertCurrent:async()=>{},apply:op=>op({})};
  assert.equal((await prepareDeltaSync(db,connection,transport,guards)).status,'more');
  assert.equal(await readMeta(db,'deltaCursor'),undefined);assert.equal(await readMeta(db,'deltaCheckpoint'),undefined);
  assert.equal(await prepareDeltaSync(db,connection,transport,guards),null);
  assert.equal(checkpoints,2);assert.ok(await readMeta(db,'deltaEnabled'));
});

test('checkpoint fragments survive interruption and invalid completion never applies partial data',async()=>{
  const {db}=await database(),local=await read(db,'appOutbox','["folders","f"]');
  const row={key:local.key,collection:local.collection,id:local.id,raw:local.raw,position:0,revision:6},raw=JSON.stringify(row),cut=raw.length>>1;
  let requests=0,applies=0,invalid=false;const guards={assertCurrent:async()=>{},apply:op=>{applies++;return op({});}};
  const transport={async delta(_action,request){
    requests++;
    if(requests===1)return {code:'ok',revision:6,after:row.key,offset:cut,rows:[{key:row.key,fragment:raw.slice(0,cut),complete:false}],complete:false};
    assert.equal(request.offset,cut);
    if(requests===2)throw Error('offline');
    return {code:'ok',revision:6,after:row.key,offset:invalid?cut:0,rows:invalid?[]:[{key:row.key,fragment:raw.slice(cut),complete:true}],complete:true};
  }};
  await assert.rejects(runDeltaSync(db,connection,transport,guards,true),/offline/);
  invalid=true;await assert.rejects(runDeltaSync(db,connection,transport,guards,true),e=>e.code==='invalid_response');
  assert.equal(applies,0);assert.equal(await readMeta(db,'deltaCursor'),undefined);assert.equal((await read(db,'appOutbox',local.key)).raw,local.raw);
  invalid=false;assert.equal((await runDeltaSync(db,connection,transport,guards,true)).status,'done');assert.equal(applies,1);
});
test('lost response reuses immutable bytes; only matching acknowledged edits are removed', async () => {
  const { db, data } = await database(); const frozen = await freezeDelta(db, connection, 'device-a');
  let committed = false, pushes = 0;
  const transport = { async delta(action, request) {
    if (action === 'receipt') return { code: 'ok', state: committed ? 'committed' : 'absent', revision: committed ? 2 : null };
    pushes++; committed = true; throw new TypeError('response lost');
  } };
  await assert.rejects(sendDelta(db, transport, frozen, async () => {}), /response lost/);
  await records.saveAppRecords(db, { ...data, folders: data.folders.map(f => ({ ...f, name: 'New edit' })) }, new Date().toISOString());
  assert.deepEqual(await freezeDelta(db, connection, 'device-a'), frozen);
  await sendDelta(db, transport, frozen, async () => {}); assert.equal(pushes, 1);
  assert.equal(await readMeta(db, 'deltaFrozen'), undefined);
  assert.equal(JSON.parse((await read(db, 'appOutbox', '["folders","f"]')).raw).name, 'New edit');
  await assert.rejects(freezeDelta(db, { ...connection, userId: 'other' }, 'device-a'), /別の同期先/);
  assert.equal(await readMeta(db, 'deltaFrozen'), undefined);
});
test('partial unrelated media and a quarantined note cannot block learning edits', async () => {
  const { db } = await database();
  const tx = db.transaction('appOutbox', 'readwrite'), done = idbDone(tx);
  for (const id of ['quizMake:notes:s:pdf', 'quizMake:notes:s:rescue']) tx.objectStore('appOutbox').put({ operationId: crypto.randomUUID(), key: records.appRecordKey('indexedDbNotes', id), collection: 'indexedDbNotes', id, raw: JSON.stringify({ dataUrl: 'data:image/png;base64,YWJj' }), position: 0, baseRevision: 0, localRevision: 2 }, records.appRecordKey('indexedDbNotes', id));
  await done;
  const frozen = await freezeDelta(db, connection, 'device-a'); assert.deepEqual(frozen.operations.map(op => op.collection), ['folders']);
});
test('one remote item preserves the replaced version and atomically advances its cursor', async () => {
  const { db } = await database();
  const tx = db.transaction('appOutbox', 'readwrite'), done = idbDone(tx); tx.objectStore('appOutbox').clear(); await done;
  const original = await read(db, 'appRecords', '["folders","f"]');
  const row = { key: original.key, collection: 'folders', id: 'f', raw: JSON.stringify({ ...JSON.parse(original.raw), name: 'Cloud' }), position: 0, revision: 3 };
  const applied = await applyDeltaRows(db, connection, [row], 3); assert.equal(applied.applied, true); assert.equal(applied.data.folders[0].name, 'Cloud');
  assert.equal((await read(db, 'recordHistory', row.key))[0].raw, original.raw);
  assert.equal((await readMeta(db, 'deltaCursor')).revision, 3);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'appRecords') throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); };
  try { await assert.rejects(applyDeltaRows(db, connection, [{ ...row, raw: original.raw, revision: 4 }], 4)); } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await readMeta(db, 'deltaCursor')).revision, 3); assert.equal((await read(db, 'appRecords', row.key)).raw, row.raw);
});
test('legacy bootstrap does not publish older unknown originals as fresh edits', async () => {
  const { db } = await database(); const local = await read(db, 'appOutbox', '["folders","f"]');
  const remote = { key: local.key, collection: local.collection, id: local.id, raw: JSON.stringify({ ...JSON.parse(local.raw), name: 'Existing cloud' }), position: 0, revision: 9 };
  const result = await applyDeltaRows(db, connection, [remote], 9, {}, true);
  assert.equal(result.data.folders[0].name, 'Existing cloud'); assert.equal(await read(db, 'appOutbox', local.key), undefined);
  assert.equal((await read(db, 'appRecordConflicts', `legacy:${local.operationId}`)).local.raw, local.raw);
});

test('an unchanged legacy checkpoint does not rebuild record accounting',async()=>{
  const {db}=await database();(await import('../src/utils/storageLedger.ts')).installStorageLedger(db);
  const original=await read(db,'appRecords','["folders","f"]'),put=IDBObjectStore.prototype.put;let recordSizes=0;
  IDBObjectStore.prototype.put=function(value,key){if(this.name==='storageLedger'&&typeof key==='string'&&key.startsWith('["appRecords",'))recordSizes++;return put.call(this,value,key);};
  try{const result=await applyDeltaRows(db,connection,[{key:original.key,collection:original.collection,id:original.id,raw:original.raw,position:original.position,revision:original.serverRevision}],1,{},true);assert.equal(result.changed,0);assert.equal(recordSizes,0);}
  finally{IDBObjectStore.prototype.put=put;}
});

test('checkpoint protects a hydrated legacy PDF and it remains available offline', async () => {
  const {db}=await database(),vault=await import('../src/utils/blobVault.ts');
  const id='quizMake:notes:s:__material_pdf_pdf',key=records.appRecordKey('indexedDbNotes',id),bytes=new Blob(['%PDF-1.4 local original'],{type:'application/pdf'});
  const ref={sha256:await vault.blobHash(bytes),size:bytes.size,type:bytes.type};
  const remote=JSON.stringify({kind:'quiz-material-remote-file',version:1,materialId:'pdf',path:'old/pdf',sha256:ref.sha256,size:ref.size,updatedAt:'2026-10-16T00:00:00Z'});
  const original=JSON.stringify({kind:'quiz-material-file',version:1,materialId:'pdf',dataUrl:await vault.blobDataUrl(bytes),updatedAt:'2026-10-16T00:00:00Z'});
  const tx=db.transaction(['appOutbox','appRecords','categoryNotes'],'readwrite'),done=idbDone(tx);tx.objectStore('appOutbox').clear();
  tx.objectStore('appRecords').put({key,id,collection:'indexedDbNotes',raw:remote,position:0,serverRevision:1,localRevision:1},key);tx.objectStore('categoryNotes').put(original,id);await done;
  // Force a fresh authoritative snapshot after creating the legacy fixture.
  await vault.writeMeta(db,'state',{...await readMeta(db,'state'),commitId:crypto.randomUUID()});
  await applyDeltaRows(db,connection,[{key,id,collection:'indexedDbNotes',raw:remote,position:0,revision:2}],2,{},true);
  const {listProtectedOriginals,readProtectedOriginal}=await import('../src/utils/recordConflictRecovery.ts');
  const rescued=await listProtectedOriginals(db);assert.equal(rescued.length,1);assert.equal(await readProtectedOriginal(db,rescued[0]),original);
  const recovered=await(await import('../src/utils/materialStorage.ts')).recoverCachedMaterial(db,id,ref);assert.equal(await recovered.text(),await bytes.text());
});

test('new material imports after migration completion are immediately transferable references',async()=>{
  const {db,data}=await database(),vault=await import('../src/utils/blobVault.ts');await vault.writeMeta(db,'deltaEnabled',{version:3});await vault.writeMeta(db,'blobMigration',{complete:true,after:'z'});
  const id='quizMake:notes:s:__material_pdf_import',raw=JSON.stringify({kind:'quiz-material-file',version:1,materialId:'import',dataUrl:'data:application/pdf;base64,JVBERg==',updatedAt:'2026-10-16T00:00:00Z'});
  await records.saveAppRecords(db,data,new Date().toISOString(),undefined,[],undefined,true,{[id]:raw});
  const pending=await read(db,'appOutbox',records.appRecordKey('indexedDbNotes',id));assert.equal(pending.transferReady,1);assert.ok(vault.parseBlobNote(pending.raw));assert.equal(await vault.unpackBlobNote(db,pending.raw),raw);
  assert.ok((await freezeDelta(db,connection,'device-a')).operations.some(op=>op.id===id));
});
