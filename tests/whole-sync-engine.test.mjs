import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
import {incomingFixture} from './helpers/whole-incoming-fixture.mjs';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
Object.defineProperty(navigator,'locks',{value:{request:async(_name,_options,run)=>run()},configurable:true});Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1024*1024*1024,usage:0})},configurable:true});
const storage=await import('../src/storage.ts'),records=await import('../src/utils/appRecordStorage.ts');
const {runWholeRecordSync}=await import('../src/utils/wholeSyncEngine.ts');
const {readWholeMeta,chooseWholeConflict,readWholeBaseline,readVerifiedWholeAncestorCursor,acknowledgeIdenticalWhole}=await import('../src/utils/wholeSyncStorage.ts');
const {prepareRecordChunks,hydrateChunkChanges}=await import('../src/utils/recordChunks.ts');
const {RECORD_CHUNK_GUARD_ID,RECORD_CHUNK_GUARD_RAW,parseChunkManifest,chunkIds}=await import('../src/utils/recordChunkFormat.ts');
const {queueAuxiliaryRecordWrite}=await import('../src/utils/auxiliaryRecordStorage.ts');
const {saveSyncedLocalStorage}=await import('../src/utils/localStorageRecords.ts');
const {withCoordinatedDataMutation}=await import('../src/utils/dataCoordination.ts');
const {wholeRowsPayload}=await import('../src/utils/wholeSyncIncoming.ts');
const {createCompleteFileBackup}=await import('../src/utils/backupPayload.ts');
const {wholeHash}=await import('../src/utils/wholeSyncDigest.ts');
const {listWholeRecovery,getWholeRecovery}=await import('../src/utils/wholeRecovery.ts');
const {setStudyCompanionEnabled}=await import('../src/utils/studyCompanion.ts');
const {readUserEditGeneration}=await import('../src/utils/userEditGeneration.ts');
const {freezeRecordPushBatch,getPendingRecordPushBatch}=await import('../src/utils/recordSyncOutbox.ts');
const pg=await createRecordProtocolDatabase();await pg.exec('create role service_role');await pg.exec(await readFile(new URL('../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261007105000_quiz_whole_finish_typed_rows.sql',import.meta.url),'utf8'));
await pg.exec("create schema auth; create function auth.uid() returns uuid language sql as $$select case when coalesce(current_setting('test.actor',true),'')='' then null else md5(current_setting('test.actor'))::uuid end$$; grant usage on schema auth to authenticated;");
await pg.exec(await readFile(new URL('../supabase/migrations/20261007165623_quiz_answer_sync_optimization.sql',import.meta.url),'utf8'));
globalThis.window={dispatchEvent(){}};
const stamp='2026-10-05T00:00:00Z',connection={project:'https://whole.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:'9'.repeat(36)};
const folder=(id,name)=>({id,name,createdAt:stamp,updatedAt:stamp}),data=(name)=>({version:1,folders:[folder('f',name)],problemSets:[],questions:[],progress:[],answerLogs:[]});
await storage.saveAppDataAsync(data('Common'));const original=await storage.loadAppDataAsync();const db=await storage.openAppDb();after(async()=>{db.close();await pg.close()});
const payload={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(original)},indexedDbNotes:{}};
await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)',[connection.syncId,stamp,JSON.stringify(payload)]);
await pg.query('select public.quiz_sync_v2_open($1,$2)',[connection.syncId,stamp]);
const signatures={status:[],open:[['p_expected_revision','bigint']],read:[['p_expected_revision','bigint'],['p_after_key','text'],['p_limit','integer']],begin:[['p_operation_id','uuid'],['p_expected_revision','bigint'],['p_parts','integer'],['p_records','integer'],['p_digest','text'],['p_device','text'],['p_replace','boolean']],part:[['p_commit_id','uuid'],['p_operation_id','uuid'],['p_number','integer'],['p_raw','text']],finish:[['p_operation_id','uuid']],abort:[['p_operation_id','uuid']],receipts:[['p_operations','jsonb']]};
const calls=[];let loseFinish=false,losePart=false,applyActive=false;
const transport={async whole(name,body={}){if(applyActive)throw new Error('network inside protected apply');calls.push({name,body:structuredClone(body)});const fields=signatures[name],args=[connection.syncId,...fields.map(([key,type])=>type==='jsonb'?JSON.stringify(body[key]):body[key])];const sql=`select public.quiz_whole_${name}($1::text${fields.map(([,type],i)=>`,$${i+2}::${type}`).join('')}) result`;const result=(await pg.query(sql,args)).rows[0].result;if(name==='finish'&&loseFinish){loseFinish=false;throw new Error('lost committed response')}if(name==='part'&&losePart){losePart=false;throw new Error('lost part response')}return result},async push(operations){return (await pg.query('select public.quiz_sync_v2_push($1,$2) result',[connection.syncId,JSON.stringify(operations)])).rows[0].result},async pull(){throw new Error('whole mode must not merge old record pull')}};
const guards={assertCurrent:async()=>{},prepareOutgoing:()=>prepareRecordChunks(db,connection),device:'QA Windows',apply:operation=>withCoordinatedDataMutation(['app','notes'],async()=>{applyActive=true;try{return await operation()}finally{applyActive=false}},{requireCrossContext:true}),incoming:rows=>createCompleteFileBackup(wholeRowsPayload(rows),[])};
const run=(overrides={})=>runWholeRecordSync(db,connection,transport,{...guards,...overrides});
const names=async()=> (await storage.loadAppDataAsync()).folders.map(row=>row.name);
async function edit(name){const prior=await storage.loadAppDataAsync();assert.equal(await storage.saveAppDataAsync({...prior,folders:[{...prior.folders[0],name}]}),true)}
async function remoteReplace(name,extra=[]){const row={key:'["folders","f"]',collection:'folders',id:'f',raw:JSON.stringify(folder('f',name)),position:0},raw=JSON.stringify([row,...extra]),status=await transport.whole('status'),id=crypto.randomUUID();assert.equal((await transport.whole('begin',{p_operation_id:id,p_expected_revision:status.revision,p_parts:1,p_records:extra.length+1,p_digest:await wholeHash(await wholeHash(raw)),p_device:'QA Android',p_replace:true})).code,'ok');assert.equal((await transport.whole('part',{p_commit_id:id,p_operation_id:crypto.randomUUID(),p_number:0,p_raw:raw})).code,'ok');assert.equal((await transport.whole('finish',{p_operation_id:id})).code,'ok')}

test('unknown cursor zero is not an ancestor; identical initial whole data establishes the baseline without upload',async()=>{
  assert.equal(await readVerifiedWholeAncestorCursor(db,connection),undefined);const result=await run();assert.equal(result.status,'done');assert.equal((await records.readAppOutbox(db)).length,0);assert.equal((await readWholeBaseline(db,connection)).serverRevision,1);assert.equal(calls.filter(row=>row.name==='begin').length,0);assert.deepEqual(await listWholeRecovery(),[]);assert.equal((await (await import('../src/utils/recordSyncStatus.ts')).readRecordSyncStatus(db,connection)).staged,false);
});
test('one-sided device change sends a delta under whole-head CAS; a lost finish retries the exact UUID and preserves a later edit',async()=>{
  await edit('Local first');loseFinish=true;await assert.rejects(run(),/lost committed response/);const frozen=await readWholeMeta(db,'wholeFrozen',connection);assert.equal(frozen.replace,false);assert.equal((await transport.whole('status')).revision,2);
  await edit('Local later');assert.equal((await run()).status,'more');assert.equal((await readWholeBaseline(db,connection)).userGeneration,frozen.generation);assert.ok((await records.readAppOutbox(db)).length);assert.equal((await transport.whole('status')).revision,2);
  assert.equal((await run()).status,'more');assert.equal((await run()).status,'done');assert.deepEqual(await names(),['Local later']);assert.equal((await transport.whole('status')).revision,3);assert.deepEqual(await listWholeRecovery(),[]);
});
test('remote-only change defers while editing, then replaces once without union or routine full archives',async()=>{
  await remoteReplace('Remote only');const before=await readUserEditGeneration(db);
  assert.equal((await run({apply:operation=>operation({preserveLiveData:true})})).status,'deferred');assert.deepEqual(await names(),['Local later']);
  assert.equal((await run()).status,'done');assert.deepEqual(await names(),['Remote only']);assert.equal(await readUserEditGeneration(db),before);assert.deepEqual(await listWholeRecovery(),[]);
});
test('both changed requires one whole choice; cloud selection archives the complete nonchosen device graph',async()=>{
  await edit('Device conflict');await remoteReplace('Cloud conflict');assert.equal((await run()).status,'conflict');const shown=await readWholeMeta(db,'wholeConflict',connection);assert.equal(shown.device,'QA Android');assert.equal(shown.local.sets,0);assert.deepEqual(await names(),['Device conflict']);
  await chooseWholeConflict(db,connection,shown,'remote');assert.equal((await run()).status,'done');assert.deepEqual(await names(),['Cloud conflict']);const copies=await listWholeRecovery();assert.equal(copies.length,1);const file=JSON.parse(await getWholeRecovery(copies[0].id));assert.equal(file.backupManifest.completeness,'complete');assert.equal(JSON.parse(file.localStorage['quiz-make-app-data-v1']).folders[0].name,'Device conflict');
});
test('local selection archives the nonchosen whole cloud before full replacement; failed part replay keeps stable IDs',async()=>{
  await edit('Device chosen');await remoteReplace('Cloud archived');assert.equal((await run()).status,'conflict');await chooseWholeConflict(db,connection,await readWholeMeta(db,'wholeConflict',connection),'local');losePart=true;await assert.rejects(run(),/lost part response/);const frozen=await readWholeMeta(db,'wholeFrozen',connection);assert.equal(frozen.replace,true);const copies=await listWholeRecovery();assert.equal(copies.length,2);const archives=await Promise.all(copies.map(async c=>JSON.parse(await getWholeRecovery(c.id))));assert.ok(archives.some(file=>JSON.parse(file.localStorage['quiz-make-app-data-v1']).folders[0].name==='Cloud archived'));
  assert.equal((await run()).status,'more');assert.equal((await run()).status,'done');const sent=calls.filter(row=>row.name==='part'&&row.body.p_commit_id===frozen.id);assert.equal(sent.length,2);assert.equal(sent[0].body.p_operation_id,sent[1].body.p_operation_id);assert.equal(sent[0].body.p_raw,sent[1].body.p_raw);assert.deepEqual(await names(),['Device chosen']);
});
test('a cloud change after a shown choice invalidates it; low recovery capacity cannot overwrite either side',async()=>{
  await edit('Capacity device');await remoteReplace('Capacity cloud');assert.equal((await run()).status,'conflict');const shown=await readWholeMeta(db,'wholeConflict',connection);await chooseWholeConflict(db,connection,shown,'remote');await remoteReplace('Third device change');assert.equal((await run()).status,'conflict');const next=await readWholeMeta(db,'wholeConflict',connection);assert.equal(next.choice,undefined);assert.notEqual(next.revision,shown.revision);
  await chooseWholeConflict(db,connection,next,'remote');Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1,usage:0})},configurable:true});await assert.rejects(run(),/容量/);assert.deepEqual(await names(),['Capacity device']);Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1024*1024*1024,usage:0})},configurable:true});assert.equal((await run()).status,'done');assert.deepEqual(await names(),['Third device change']);
});
test('preference commits are part of the whole dirty witness; failed or no-op saves do not inflate it',async()=>{
  const before=await readUserEditGeneration(db);await setStudyCompanionEnabled(false);assert.equal(await readUserEditGeneration(db),before+1);await setStudyCompanionEnabled(false);assert.equal(await readUserEditGeneration(db),before+1);assert.equal((await run()).status,'more');assert.equal((await run()).status,'done');const cloud=await transport.whole('read',{p_expected_revision:(await transport.whole('status')).revision,p_after_key:'',p_limit:200});assert.ok(cloud.rows.some(row=>row.id==='quiz-make-study-companion'&&row.raw==='off'));
});
test('a pre-upgrade lost old receipt is resolved behind the writer fence without merging or replaying an old write',async()=>{
  await edit('Old receipt recovered');const batch=await freezeRecordPushBatch(db,connection);
  // Simulate the old request committing immediately before a different updated
  // client enables the fence. This fixture change never goes to production.
  await pg.query('update private.quiz_sync_heads set whole_enabled=false where sync_id=$1',[connection.syncId]);
  assert.equal((await transport.push(batch.operations)).code,'ok');
  await pg.query('update private.quiz_sync_heads set whole_enabled=true where sync_id=$1',[connection.syncId]);
  const before=calls.length;assert.equal((await run()).status,'done');assert.equal(await getPendingRecordPushBatch(db,connection),null);assert.ok(calls.slice(before).some(row=>row.name==='receipts'));assert.deepEqual(await names(),['Old receipt recovered']);
});
test('an old batch that definitively never committed is released without losing its pending device edit',async()=>{
  await edit('Old unsent edit');await freezeRecordPushBatch(db,connection);assert.equal((await run()).status,'more');assert.equal(await getPendingRecordPushBatch(db,connection),null);assert.equal((await run()).status,'done');assert.deepEqual(await names(),['Old unsent edit']);
});

async function readCloudRows(){
  const head=await transport.whole('status'),rows=[];let after='';
  for(;;){const page=await transport.whole('read',{p_expected_revision:head.revision,p_after_key:after,p_limit:200});assert.equal(page.code,'ok');rows.push(...page.rows);if(!page.hasMore)return rows;assert.notEqual(page.afterKey,after);after=page.afterKey}
}
const largeKey='quizMake:large-sync-fixture',largeRaw='X'.repeat(1200000);let oldChunkIds;
test('a large delta includes its existing chunk guard even when equality already cleared the guard outbox',async()=>{
  const tx=db.transaction(['appRecordMeta','appRecords','appRecordBackups','appOutbox'],'readwrite');
  const complete=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
  queueAuxiliaryRecordWrite(tx,'localStorage',RECORD_CHUNK_GUARD_ID,RECORD_CHUNK_GUARD_RAW,false);await complete;
  await acknowledgeIdenticalWhole(db,await readWholeBaseline(db,connection));
  assert.equal((await records.readAppOutbox(db)).length,0);
  assert.equal((await records.readAppRecordSnapshot(db)).records.get(records.appRecordKey('localStorage',RECORD_CHUNK_GUARD_ID)).serverRevision,0);
  assert.equal((await readCloudRows()).some(row=>row.id===RECORD_CHUNK_GUARD_ID),false);
  await withCoordinatedDataMutation(['app','notes'],()=>saveSyncedLocalStorage({[largeKey]:largeRaw}),{requireCrossContext:true});
  const generation=await readUserEditGeneration(db);
  assert.equal((await run()).status,'more');assert.equal((await run()).status,'done');
  const cloud=await readCloudRows(),parent=cloud.find(row=>row.id===largeKey);
  assert.ok(cloud.some(row=>row.id===RECORD_CHUNK_GUARD_ID&&row.raw===RECORD_CHUNK_GUARD_RAW));
  assert.equal((await hydrateChunkChanges(db,cloud,connection,true)).find(row=>row.id===largeKey).logicalRaw,largeRaw);
  oldChunkIds=chunkIds(parseChunkManifest(parent.raw,parent.collection,parent.id));
  assert.equal(await readUserEditGeneration(db),generation);
});
test('obsolete wire chunks are deleted by an acknowledged maintenance commit despite unchanged logical data',async()=>{
  await withCoordinatedDataMutation(['app','notes'],()=>saveSyncedLocalStorage({[largeKey]:'Y'.repeat(1200000)}),{requireCrossContext:true});
  const generation=await readUserEditGeneration(db),copies=(await listWholeRecovery()).length;
  assert.equal((await run()).status,'more');
  const before=new Set((await readCloudRows()).map(row=>row.id));assert.ok(oldChunkIds.every(id=>before.has(id)));
  const revision=(await transport.whole('status')).revision;
  assert.equal((await run()).status,'more');assert.equal((await transport.whole('status')).revision,revision+1);
  assert.equal((await run()).status,'done');const cloud=await readCloudRows();assert.ok(oldChunkIds.every(id=>!cloud.some(row=>row.id===id)));
  assert.equal((await hydrateChunkChanges(db,cloud,connection,true)).find(row=>row.id===largeKey).logicalRaw,'Y'.repeat(1200000));
  assert.equal(await readUserEditGeneration(db),generation);assert.equal((await listWholeRecovery()).length,copies);
});

const atomicTransport={...transport,async commitSmallWhole(body){
  calls.push({name:'commit',body:structuredClone(body)});
  const fields=[['p_operation_id','uuid'],['p_expected_revision','bigint'],['p_records','integer'],['p_digest','text'],['p_device','text'],['p_part_id','uuid'],['p_raw','text']];
  return (await pg.query(`select public.quiz_whole_commit($1::text${fields.map(([,type],i)=>`,$${i+2}::${type}`).join('')}) result`,[connection.syncId,...fields.map(([key])=>body[key])])).rows[0].result;
}};
const runAtomic=()=>runWholeRecordSync(db,connection,atomicTransport,guards);
test('one small edit finishes in three RPCs without rereading all records or scheduling another confirmation cycle',async()=>{
  await edit('Small atomic edit');const start=calls.length;
  const originalGetAll=IDBObjectStore.prototype.getAll;let fullReads=0;
  IDBObjectStore.prototype.getAll=function(...args){if(this.name==='appRecords')fullReads++;return originalGetAll.apply(this,args)};
  let result;try{result=await runAtomic()}finally{IDBObjectStore.prototype.getAll=originalGetAll}
  assert.equal(result.status,'done');assert.equal(result.uploaded,1);assert.equal(fullReads,0);
  assert.deepEqual(calls.slice(start).map(row=>row.name),['status','commit','status']);
  assert.equal((await records.readAppOutbox(db)).length,0);
  console.log('synthetic-small-sync '+JSON.stringify({rpcCalls:3,fullRecordReads:fullReads,finished:true}));
});
test('a lost small commit response replays the exact frozen bytes and preserves an edit made before retry',async()=>{
  await edit('Atomic response lost');const start=calls.length;
  let lost=true;
  const losing={...atomicTransport,async commitSmallWhole(body){const reply=await atomicTransport.commitSmallWhole(body);if(lost){lost=false;throw Error('lost small committed response')}return reply}};
  await assert.rejects(runWholeRecordSync(db,connection,losing,guards),/lost small committed response/);
  const frozen=await readWholeMeta(db,'wholeFrozen',connection);assert.ok(frozen);assert.equal(frozen.replace,false);
  const revision=(await transport.whole('status')).revision;
  await edit('Later answer remains');assert.equal((await runAtomic()).status,'more');
  assert.equal((await transport.whole('status')).revision,revision);assert.ok((await records.readAppOutbox(db)).length);
  const sent=calls.slice(start).filter(row=>row.name==='commit');assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);
  assert.equal((await runAtomic()).status,'done');assert.deepEqual(await names(),['Later answer remains']);
  assert.equal((await transport.whole('status')).revision,revision+1);
});

test('an invalid cloud material reference retains both originals across failure, retry and explicit source reselection',async()=>{
  const fixture=await incomingFixture({badRef:true}),{buildWholeIncomingFile}=await import('../src/utils/wholeSyncIncoming.ts');
  const {archiveSyncOriginals}=await import('../src/utils/syncOriginalBackup.ts'),{getSavedBackup}=await import('../src/utils/backupRepository.ts');
  await edit('Healthy device');await runAtomic();
  await remoteReplace('Invalid cloud',fixture.rows.filter(row=>row.collection!=='folders'));
  const remoteRevision=(await transport.whole('status')).revision,cloudBefore=JSON.stringify(await readCloudRows()),outboxBefore=JSON.stringify(await records.readAppOutbox(db));
  const media={userId:fixture.transport.userId,exists:async()=>true,upload:async()=>assert.fail('no image upload'),download:async()=>assert.fail('no image download')};
  const exact={...guards,incoming:(rows,options)=>buildWholeIncomingFile(db,rows,fixture.transport,async()=>{},undefined,options?.allowMissingImages),archiveOriginals:(side,rows)=>archiveSyncOriginals(db,connection,side,rows,media,fixture.transport,async()=>{})};
  const receive=()=>runWholeRecordSync(db,connection,transport,exact);
  for(let i=0;i<2;i++){
    await assert.rejects(receive(),e=>e.code==='material_reference');assert.deepEqual(await names(),['Healthy device']);assert.equal(JSON.stringify(await readCloudRows()),cloudBefore);assert.equal(JSON.stringify(await records.readAppOutbox(db)),outboxBefore);assert.equal(Boolean(await readWholeMeta(db,'wholeFrozen',connection)),false);
  }
  let choice=await readWholeMeta(db,'wholeConflict',connection);assert.equal(choice.choice,undefined);assert.equal(choice.revision,remoteRevision);
  await chooseWholeConflict(db,connection,choice,'remote',{preferSelected:true});await assert.rejects(receive(),e=>e.code==='material_reference');assert.equal((await readWholeMeta(db,'wholeConflict',connection)).choice,'remote');assert.deepEqual(await names(),['Healthy device']);
  choice=await readWholeMeta(db,'wholeConflict',connection);await chooseWholeConflict(db,connection,choice,'local',{preferSelected:true});
  assert.equal((await receive()).status,'more');assert.equal((await receive()).status,'done');assert.deepEqual(await names(),['Healthy device']);
  const backupRows=(await import('../src/utils/backupRepository.ts')).listSavedBackups;let preserved=false;
  for(const header of await backupRows()){const copy=await getSavedBackup(header.id);if(copy?.format==='originals'&&copy.raw.includes('nonexistent-private-id'))preserved=true;}
  assert.equal(preserved,true,'invalid references remain byte-for-byte in the nonchosen original backup');
});
