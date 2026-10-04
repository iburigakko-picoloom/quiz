import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {after,test} from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
import {largeNoteRaw} from './helpers/large-note-fixture.mjs';
const hooks=registerHooks({resolve(s,c,next){return next(/^\.\.?\//u.test(s)&&! /\.[cm]?[jt]sx?$/u.test(s)&&c.parentURL?.endsWith('.ts')?s+'.ts':s,c)}});
after(()=>hooks.deregister());
const originalKeyRange=globalThis.IDBKeyRange;
globalThis.IDBKeyRange=IDBKeyRange;
after(()=>{globalThis.IDBKeyRange=originalKeyRange});
const format=await import('../src/utils/recordChunkFormat.ts');
const {prepareRecordChunks}=await import('../src/utils/recordChunks.ts');
const records=await import('../src/utils/appRecordStorage.ts');
const {queueAuxiliaryRecordWrite}=await import('../src/utils/auxiliaryRecordStorage.ts');
const {runRecordSync}=await import('../src/utils/recordSyncEngine.ts');
const outbox=await import('../src/utils/recordSyncOutbox.ts');
const pull=await import('../src/utils/recordSyncPull.ts');
const plans=await import('../src/utils/studyPlans.ts');
const {normalizeAppData}=await import('../src/utils/appDataValidation.ts');
const {isValidCategoryNoteRaw}=await import('../src/utils/noteStorage.ts');
const {validateSyncPayload,validateHydratedSyncPayload}=await import('../src/utils/syncService.ts');
const {writeRecordSyncReceipt,readRecordSyncStatus}=await import('../src/utils/recordSyncStatus.ts');
const {recordConflictTitle}=await import('../src/utils/recordConflictPresentation.ts');
const {exportRecordConflictOriginals}=await import('../src/utils/recordConflictExport.ts');
const pg=await createRecordProtocolDatabase();after(()=>pg.close());
const stamp='2026-10-04T00:00:00.000Z';
const complete=tx=>new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error??Error('aborted'))});
async function stored(db,store,key){const tx=db.transaction(store,'readonly'),done=complete(tx),q=tx.objectStore(store).get(key);await done;return q.result}
async function database(factory){return new Promise((r,j)=>{const q=factory.open('chunks',7);q.onupgradeneeded=()=>records.upgradeAppRecordStores(q.result);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}
function data(n=1){
  return normalizeAppData({version:1,folders:[{id:'f',name:'Folder',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'Set',source:'',createdAt:stamp,updatedAt:stamp}],questions:Array.from({length:n},(_,i)=>({id:'q'+i,setId:'s',question:'問題 '+i,choices:['a','b','c','d'],answerIndex:0,answerText:'a',explanation:'Synthetic explanation. '.repeat(30),createdAt:stamp,updatedAt:stamp})),progress:[],answerLogs:[]}).data;
}
function planRaw(d,id='p'){return JSON.stringify({schema:1,id,title:'固定した計画',setId:'s',setTitle:'Set',timeZone:'Etc/UTC',createdAt:stamp,updatedAt:stamp,targets:plans.snapshotTargets(d.questions,d.answerLogs),schedules:[{effectiveDay:'2026-10-04',kind:'deadline',deadline:'2026-11-01',weekdays:[0,1,2,3,4,5,6],holidays:[],dailyCounts:[5,5,5,5,5,5,5],paused:false}]})}
async function auxiliary(db,c,id,raw){
  const tx=db.transaction(records.APP_RECORD_STORES,'readwrite'),done=complete(tx);queueAuxiliaryRecordWrite(tx,c,id,raw);
  if(c==='indexedDbNotes'){if(raw===null)tx.objectStore('categoryNotes').delete(id);else tx.objectStore('categoryNotes').put(raw,id)}
  else tx.objectStore('localProjections').put(raw,id);
  await done;
}
let sequence=20000;
async function fixture(n=1){
  const connection={project:'https://test.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:String(sequence++).padStart(36,'0')},initial=data(n);
  const payload={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(initial)},indexedDbNotes:{}};
  await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)',[connection.syncId,stamp,JSON.stringify(payload)]);
  await pg.query('select public.quiz_sync_v2_open($1,$2)',[connection.syncId,stamp]);
  const pushed=[];
  const transport={
    async pull(cursor){return(await pg.query('select public.quiz_sync_v2_pull($1,$2,20) as value',[connection.syncId,cursor])).rows[0].value},
    async push(ops){pushed.push(structuredClone(ops));const value=(await pg.query('select public.quiz_sync_v2_push($1,$2) as value',[connection.syncId,JSON.stringify(ops)])).rows[0].value;assert.ok(Buffer.byteLength(JSON.stringify(ops))<=900*1024);return value},
  };
  const factories=[new IDBFactory(),new IDBFactory()],devices=await Promise.all(factories.map(database));
  const guards=db=>({assertCurrent:async()=>{},apply:op=>op(),prepareOutgoing:()=>prepareRecordChunks(db,connection)});
  const run=(db,t=transport,g=guards(db))=>runRecordSync(db,connection,t,g);
  for(const db of devices){await records.saveAppRecords(db,initial,stamp);assert.equal((await run(db)).status,'done')}
  return {connection,initial,factories,devices,transport,pushed,guards,run,close(){devices.forEach(db=>db.close())}};
}
const logical=async(db,c,id)=>{const row=await stored(db,'appRecords',records.appRecordKey(c,id));return row?.logicalRaw??row?.raw??null};
const snapshot=async f=>(await pg.query('select data from public.quiz_sync_read($1)',[f.connection.syncId])).rows[0].data;
function failParentPut(db,key){
  return new Proxy(db,{get(target,property){
    if(property!=='transaction'){const value=target[property];return typeof value==='function'?value.bind(target):value}
    return (...args)=>{const tx=target.transaction(...args);if(args[1]!=='readwrite')return tx;
      const objectStore=tx.objectStore.bind(tx);
      tx.objectStore=name=>{const store=objectStore(name);if(name==='appRecords'){
        const put=store.put.bind(store);store.put=(value,id)=>{if(id===key)throw new DOMException('Synthetic quota failure','QuotaExceededError');return put(value,id)};
      }return store};return tx;
    };
  }});
}

test('UTF-8, BOM, controls and multibyte split boundaries roundtrip exactly; malformed or missing parts fail closed',async()=>{
  const raw='\ufeff'+('問😀\u0000\r\n').repeat(40000),encoded=await format.encodeRecordChunks('localStorage','quizMake:test',raw);
  const values=new Map(encoded.parts.map(p=>[p.id,p.raw]));
  assert.equal(await format.restoreRecordChunks(encoded.manifest,values),raw);
  await assert.rejects(format.encodeRecordChunks('localStorage','quizMake:test','invalid '+String.fromCharCode(0xd800)),e=>e.code==='invalid_response');
  const missing=new Map(values);missing.delete(encoded.parts[1].id);await assert.rejects(format.restoreRecordChunks(encoded.manifest,missing),e=>e.code==='invalid_response');
  const corrupt=new Map(values),part=JSON.parse(encoded.parts[0].raw);part.data='A'+part.data.slice(1);corrupt.set(encoded.parts[0].id,JSON.stringify(part));await assert.rejects(format.restoreRecordChunks(encoded.manifest,corrupt));
  for(const change of [{count:encoded.manifest.count+1},{totalBytes:encoded.manifest.totalBytes-1},{version:'0'.repeat(64)}]){
    const m={...encoded.manifest,...change};
    await assert.rejects(async()=>{format.parseChunkManifest(JSON.stringify(m),'localStorage','quizMake:test');await format.restoreRecordChunks(m,values)});
  }
});
test('valid 695-question plan completes through unchanged server SQL and restores exact versions on a second device and Snapshot',async()=>{
  const f=await fixture(695),[a,b]=f.devices,id='quizMake:plan:p',raw=planRaw(f.initial);
  try{
    assert.deepEqual(plans.parseStudyPlan(raw),JSON.parse(raw));assert.ok(Buffer.byteLength(raw)>900*1024);
    await auxiliary(a,'localStorage',id,raw);assert.equal((await f.run(a)).status,'done');assert.equal((await records.readAppOutbox(a)).length,0);
    const parent=await stored(a,'appRecords',records.appRecordKey('localStorage',id)),manifest=format.parseChunkManifest(parent.raw,'localStorage',id);
    assert.ok(manifest);assert.equal(parent.logicalRaw,raw);
    const parentBatch=f.pushed.findIndex(ops=>ops.some(op=>op.id===id));
    assert.ok(parentBatch>0);for(const partId of format.chunkIds(manifest))assert.ok(f.pushed.slice(0,parentBatch).some(ops=>ops.some(op=>op.id===partId)));
    assert.equal((await f.run(b)).status,'done');assert.equal(await logical(b,'localStorage',id),raw);assert.equal(await stored(b,'localProjections',id),raw);
    const decoded=await format.hydrateChunkPayload(await snapshot(f));assert.equal(decoded.localStorage[id],raw);assert.equal(validateSyncPayload(decoded).ok,true);
    assert.ok(!Object.keys(decoded.localStorage).some(id=>format.isChunkInternal('localStorage',id)));
    const validated=await validateHydratedSyncPayload(await snapshot(f));assert.equal(validated.ok,true);assert.equal(validated.value.localStorage[id],raw);
    assert.deepEqual(plans.parseStudyPlan(validated.value.localStorage[id]).targets,JSON.parse(raw).targets);
  }finally{f.close()}
});
test('large image note preserves every data URL, page and byte on receive and backup hydration',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:notes:s:category';
  const raw=largeNoteRaw(stamp);
  try{assert.equal(isValidCategoryNoteRaw(raw),true);await auxiliary(a,'indexedDbNotes',id,raw);assert.equal((await f.run(a)).status,'done');assert.equal(await stored(a,'categoryNotes',id),raw);assert.equal((await f.run(b)).status,'done');assert.equal(await stored(b,'categoryNotes',id),raw);assert.equal(await logical(b,'indexedDbNotes',id),raw);assert.equal((await format.hydrateChunkPayload(await snapshot(f))).indexedDbNotes[id],raw)}finally{f.close()}
});
test('missing chunk keeps the old plan and receipt; repaired manual refetch reconstructs the complete staged version',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',old=planRaw(f.initial),raw=planRaw(data(695));
  try{
    await auxiliary(a,'localStorage',id,old);await f.run(a);await f.run(b);await writeRecordSyncReceipt(b,f.connection,{status:'done',uploaded:0,downloaded:0},stamp);
    await auxiliary(a,'localStorage',id,raw);await f.run(a);
    const parent=await stored(a,'appRecords',records.appRecordKey('localStorage',id)),manifest=format.parseChunkManifest(parent.raw,'localStorage',id),missing=format.chunkIds(manifest)[0];
    const corrupt={...f.transport,pull:async cursor=>{const page=await f.transport.pull(cursor);for(const batch of page.batches)batch.changes=batch.changes.filter(row=>row.id!==missing);return page}};
    await assert.rejects(f.run(b,corrupt),e=>e.code==='invalid_response');assert.equal(await logical(b,'localStorage',id),old);assert.equal((await readRecordSyncStatus(b,f.connection)).lastSuccessAt,stamp);
    assert.equal((await stored(b,'appRecordMeta','pullStage')).cursor,0);
    assert.equal((await f.run(b)).status,'done');assert.equal(await logical(b,'localStorage',id),raw);
  }finally{f.close()}
});
test('unknown receipt survives restart and later editing with the exact frozen operation IDs and bytes',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',raw=planRaw(data(695));
  try{
    await auxiliary(a,'localStorage',id,raw);let first=true;
    const lost={...f.transport,push:async ops=>{const value=await f.transport.push(ops);if(first){first=false;throw Error('lost response')}return value}};
    await assert.rejects(f.run(a,lost),/lost response/);
    const frozen=await outbox.getPendingRecordPushBatch(a,f.connection);assert.ok(frozen);
    const edited=JSON.stringify({...JSON.parse(raw),title:'編集中に変更した計画'});
    await auxiliary(a,'localStorage',id,edited);await prepareRecordChunks(a,f.connection);assert.deepEqual(await outbox.getPendingRecordPushBatch(a,f.connection),frozen);
    a.close();const restarted=await database(f.factories[0]);f.devices[0]=restarted;
    assert.deepEqual(await outbox.getPendingRecordPushBatch(restarted,f.connection),frozen);
    assert.equal((await f.run(restarted)).status,'done');assert.deepEqual(f.pushed[1],frozen.operations);
    assert.equal((await f.run(b)).status,'done');assert.equal(await logical(b,'localStorage',id),edited);assert.equal((await records.readAppOutbox(restarted)).length,0);
  }finally{f.close()}
});
test('concurrent plan versions remain a conflict with both full originals, then explicit choice uses CAS',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',initial=planRaw(data(695));
  try{
    await auxiliary(a,'localStorage',id,initial);await f.run(a);await f.run(b);
    const left=JSON.stringify({...JSON.parse(initial),title:'端末A'}),right=JSON.stringify({...JSON.parse(initial),title:'端末B'});
    await auxiliary(a,'localStorage',id,left);await auxiliary(b,'localStorage',id,right);await f.run(a);
    const conflict=await f.run(b);assert.equal(conflict.status,'conflict');const item=conflict.conflicts.find(row=>row.remote.id===id);
    assert.equal(item.local.logicalRaw,right);assert.equal(item.remote.logicalRaw,left);
    assert.ok(recordConflictTitle(item,new Map()).includes(JSON.parse(right).title));
    const exported=JSON.parse(exportRecordConflictOriginals(item,conflict.conflicts));assert.equal(exported.local.raw,right);assert.equal(exported.remote.raw,left);
    await pull.applyStagedRecordPull(b,f.connection,[{key:item.key,operationId:item.operationId,remoteRevision:item.remote.revision,choice:'local'}]);
    assert.equal((await f.run(b)).status,'done');assert.equal((await f.run(a)).status,'done');assert.equal(await logical(a,'localStorage',id),right);
  }finally{f.close()}
});
test('parent deletion is received before chunk cleanup; cleanup cannot resurrect the plan or leak transport keys',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',raw=planRaw(data(695));
  try{
    await auxiliary(a,'localStorage',id,raw);await f.run(a);await f.run(b);
    const m=format.parseChunkManifest((await stored(a,'appRecords',records.appRecordKey('localStorage',id))).raw,'localStorage',id),start=f.pushed.length;
    await auxiliary(a,'localStorage',id,null);assert.equal((await f.run(a)).status,'done');
    const later=f.pushed.slice(start),parentBatch=later.findIndex(ops=>ops.some(op=>op.id===id&&op.raw===null));
    for(const part of format.chunkIds(m))assert.ok(later.findIndex(ops=>ops.some(op=>op.id===part&&op.raw===null))>parentBatch);
    await f.run(b);assert.equal(await logical(b,'localStorage',id),null);
    const payload=await format.hydrateChunkPayload(await snapshot(f));assert.equal(payload.localStorage[id],undefined);assert.ok(!Object.keys(payload.localStorage).some(id=>format.isChunkInternal('localStorage',id)));
  }finally{f.close()}
});
test('account/project/stream changes cannot prepare or restore another binding and server SQL rejects another actor',async()=>{
  const f=await fixture(),[a]=f.devices,id='quizMake:plan:p',raw=planRaw(data(695));
  try{
    await auxiliary(a,'localStorage',id,raw);const before=await records.readAppOutbox(a);
    for(const change of [{userId:'another-account'},{project:'https://another.invalid'},{syncId:'0'.repeat(36)}])await assert.rejects(prepareRecordChunks(a,{...f.connection,...change}),e=>e.reason==='connection_changed');
    assert.deepEqual(await records.readAppOutbox(a),before);assert.equal(await logical(a,'localStorage',id),raw);
    await pg.query("select set_config('test.actor','foreign',false)");await assert.rejects(f.transport.pull(0));
  }finally{await pg.query("select set_config('test.actor','owner',false)");f.close()}
});
test('published plan parser rejects the compatibility guard and manifest; new clients never project guard/parts into plans',async()=>{
  const encoded=await format.encodeRecordChunks('localStorage','quizMake:plan:p',planRaw(data(695)));
  assert.throws(()=>plans.parseStudyPlan(format.RECORD_CHUNK_GUARD_RAW));assert.throws(()=>plans.parseStudyPlan(encoded.raw));
  const value={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(data()),[format.RECORD_CHUNK_GUARD_ID]:format.RECORD_CHUNK_GUARD_RAW,'quizMake:plan:p':encoded.raw,...Object.fromEntries(encoded.parts.map(p=>[p.id,p.raw]))},indexedDbNotes:{}};
  assert.equal(validateSyncPayload(value).ok,false);const hydrated=await validateHydratedSyncPayload(value);assert.equal(hydrated.ok,true);assert.ok(!Object.keys(hydrated.value.localStorage).some(id=>format.isChunkInternal('localStorage',id)));
  const missing={...value,localStorage:{...value.localStorage}};delete missing.localStorage[encoded.parts[0].id];assert.equal((await validateHydratedSyncPayload(missing)).ok,false);assert.equal(missing.localStorage['quizMake:plan:p'],encoded.raw);
});

test('an edit or deletion during asynchronous encoding never replaces the latest source or resurrects a plan',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',raw=planRaw(data(695));
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  try{
    for(const replacement of [JSON.stringify({...JSON.parse(raw),title:'Edited during encoding'}),null]){
      await auxiliary(a,'localStorage',id,raw);
      let release,started;const wait=new Promise(r=>{release=r}),entered=new Promise(r=>{started=r});let first=true;
      crypto.subtle.digest=async(...args)=>{if(first){first=false;started();await wait}return digest(...args)};
      const preparing=prepareRecordChunks(a,f.connection);await entered;
      await auxiliary(a,'localStorage',id,replacement);release();
      await assert.rejects(preparing,e=>e instanceof outbox.RecordSyncLocalChangedError);crypto.subtle.digest=digest;
      assert.equal(await logical(a,'localStorage',id),replacement);
      assert.equal((await f.run(a)).status,'done');assert.equal((await f.run(b)).status,'done');assert.equal(await logical(b,'localStorage',id),replacement);
    }
  }finally{crypto.subtle.digest=digest;f.close()}
});

test('preparation quota abort rolls back guard, chunks, manifest and operation identity together',async()=>{
  const f=await fixture(),[a]=f.devices,id='quizMake:plan:p',raw=planRaw(data(695)),key=records.appRecordKey('localStorage',id);
  try{
    await auxiliary(a,'localStorage',id,raw);const before=await records.readAppOutbox(a);
    await assert.rejects(prepareRecordChunks(failParentPut(a,key),f.connection),e=>e.name==='QuotaExceededError');
    assert.deepEqual(await records.readAppOutbox(a),before);assert.equal(await logical(a,'localStorage',id),raw);
    assert.equal(await stored(a,'appRecords',records.appRecordKey('localStorage',format.RECORD_CHUNK_GUARD_ID)),undefined);
    assert.equal((await f.run(a)).status,'done');assert.equal((await records.readAppOutbox(a)).length,0);
  }finally{f.close()}
});

test('receive quota abort keeps the old plan, projections and receipt; complete stage can be retried',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',old=planRaw(f.initial),raw=planRaw(data(695)),key=records.appRecordKey('localStorage',id);
  try{
    await auxiliary(a,'localStorage',id,old);await f.run(a);await f.run(b);await writeRecordSyncReceipt(b,f.connection,{status:'done',uploaded:0,downloaded:0},stamp);
    const oldProjection=await stored(b,'localProjections',id);
    await auxiliary(a,'localStorage',id,raw);await f.run(a);
    await assert.rejects(f.run(failParentPut(b,key)),e=>e.name==='QuotaExceededError');
    assert.equal(await logical(b,'localStorage',id),old);assert.equal(await stored(b,'localProjections',id),oldProjection);assert.equal((await readRecordSyncStatus(b,f.connection)).lastSuccessAt,stamp);
    assert.ok(await stored(b,'appRecordMeta','pullStage'));assert.equal((await f.run(b)).status,'done');assert.equal(await logical(b,'localStorage',id),raw);
  }finally{f.close()}
});

test('offline before upload preserves a frozen request over restart and delivers all chunks on retry',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:plan:p',raw=planRaw(data(695));
  try{
    await auxiliary(a,'localStorage',id,raw);
    await assert.rejects(f.run(a,{...f.transport,push:async()=>{throw Error('offline')}}),/offline/);
    const frozen=await outbox.getPendingRecordPushBatch(a,f.connection);assert.ok(frozen);assert.equal(f.pushed.length,0);
    a.close();const restarted=await database(f.factories[0]);f.devices[0]=restarted;
    assert.equal((await f.run(restarted)).status,'done');assert.deepEqual(f.pushed[0],frozen.operations);
    assert.equal((await f.run(b)).status,'done');assert.equal(await logical(b,'localStorage',id),raw);
  }finally{f.close()}
});

test('corrupt chunk content fails before replacing existing note pages; repair and subsequent note deletion are exact',async()=>{
  const f=await fixture(),[a,b]=f.devices,id='quizMake:notes:s:category',raw=largeNoteRaw(stamp);
  const old=JSON.stringify({...JSON.parse(raw),pages:[{id:'old',dataUrl:'data:image/png;base64,aGVsbG8=',updatedAt:stamp}]});
  try{
    await auxiliary(a,'indexedDbNotes',id,old);await f.run(a);await f.run(b);
    await auxiliary(a,'indexedDbNotes',id,raw);await f.run(a);
    const corrupt={...f.transport,pull:async cursor=>{const page=await f.transport.pull(cursor);let changed=false;
      for(const batch of page.batches)for(const row of batch.changes)if(!changed&&row.id.startsWith(format.RECORD_CHUNK_PREFIX)&&row.raw){const part=JSON.parse(row.raw);part.data=(part.data[0]==='A'?'B':'A')+part.data.slice(1);row.raw=JSON.stringify(part);changed=true}return page;
    }};
    await assert.rejects(f.run(b,corrupt),e=>e.code==='invalid_response');assert.equal(await stored(b,'categoryNotes',id),old);
    assert.equal((await f.run(b)).status,'done');assert.equal(await stored(b,'categoryNotes',id),raw);
    await auxiliary(a,'indexedDbNotes',id,null);await f.run(a);await f.run(b);assert.equal(await stored(b,'categoryNotes',id),undefined);
    assert.equal((await format.hydrateChunkPayload(await snapshot(f))).indexedDbNotes[id],undefined);
  }finally{f.close()}
});
