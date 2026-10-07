import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
Object.defineProperty(navigator,'locks',{value:{request:async(_name,_options,run)=>run()},configurable:true});
const storage=await import('../src/storage.ts');
const {readAppRecordSnapshot,readAppOutbox}=await import('../src/utils/appRecordStorage.ts');
const {saveSyncedLocalStorage}=await import('../src/utils/localStorageRecords.ts');
const {withCoordinatedDataMutation}=await import('../src/utils/dataCoordination.ts');
const {bindRecordSyncConnection}=await import('../src/utils/recordSyncOutbox.ts');
const {prepareRecordChunks,hydrateChunkChanges}=await import('../src/utils/recordChunks.ts');
const {freezeWholeUpload,readWholeMeta}=await import('../src/utils/wholeSyncStorage.ts');
const {sendFrozenWhole}=await import('../src/utils/wholeSyncEngine.ts');
const {computeWholeRecordDigest,wholeHash}=await import('../src/utils/wholeSyncDigest.ts');
const {readUserEditGeneration}=await import('../src/utils/userEditGeneration.ts');

test('representative 25 MiB whole replacement resumes exact parts after restart and lost responses without rewriting the full progress body',async()=>{
  const pg=await createRecordProtocolDatabase();globalThis.window={dispatchEvent(){}};let db;
  const originalPut=IDBObjectStore.prototype.put,originalGet=IDBObjectStore.prototype.get;
  const metrics={progressWrites:0,progressBytes:0,progressBodyReads:0,progressBoundaryMs:0,accountingMs:0};let measuring=false,waitingSince;
  IDBObjectStore.prototype.put=function(value,key){if(measuring&&this.name==='appRecordMeta'&&['wholeFrozen','wholeFrozenProgress'].includes(key)){const start=performance.now();metrics.progressBytes+=Buffer.byteLength(JSON.stringify(value));metrics.accountingMs+=performance.now()-start;metrics.progressWrites++}return originalPut.call(this,value,key)};
  IDBObjectStore.prototype.get=function(key){if(measuring&&this.name==='appRecordMeta'&&key==='wholeFrozen')metrics.progressBodyReads++;return originalGet.call(this,key)};
  try{
    await pg.exec('create role service_role');await pg.exec(await readFile(new URL('../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
    const connection={project:'https://large-progress.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:'8'.repeat(36)},stamp='2026-10-05T00:00:00Z';
    await storage.saveAppDataAsync({version:1,folders:[{id:'synthetic-folder',name:'Synthetic learning metadata',createdAt:stamp,updatedAt:stamp}],problemSets:[],questions:[],progress:[],answerLogs:[]});db=await storage.openAppDb();await bindRecordSyncConnection(db,connection);
    await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)',[connection.syncId,stamp,JSON.stringify({version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(await storage.loadAppDataAsync())},indexedDbNotes:{}})]);
    await pg.query('select public.quiz_sync_v2_open($1,$2)',[connection.syncId,stamp]);assert.equal((await pg.query('select public.quiz_whole_open($1,1) result',[connection.syncId])).rows[0].result.code,'ok');
    const key='quizMake:synthetic-learning-metadata',prefix=JSON.stringify({schema:1,questionId:'synthetic-question',range:'synthetic-learning-plan',savedMetadata:''}).slice(0,-2),raw=prefix+'S'.repeat(25*1024*1024-prefix.length-2)+'"}';
    assert.equal(Buffer.byteLength(raw),25*1024*1024);assert.equal(JSON.parse(raw).schema,1);
    await withCoordinatedDataMutation(['app','notes'],()=>saveSyncedLocalStorage({[key]:raw}),{requireCrossContext:true});await prepareRecordChunks(db,connection);
    const snapshot=await readAppRecordSnapshot(db),rows=[...snapshot.records.values()].filter(row=>row.raw!==null).map(({key,collection,id,raw,position})=>({key,collection,id,raw,position})),groups=[];let group=[],bytes=2;
    for(const row of rows){const text=JSON.stringify(row),size=Buffer.byteLength(text)+1;if(group.length&&bytes+size>921600){groups.push('['+group.join(',')+']');group=[];bytes=2}group.push(text);bytes+=size}if(group.length)groups.push('['+group.join(',')+']');
    let hashes='';const parts=[];for(const raw of groups){hashes+=await wholeHash(raw);parts.push({id:crypto.randomUUID(),raw})}
    const generation=await readUserEditGeneration(db),outbox=await readAppOutbox(db),frozen={version:1,connection,id:crypto.randomUUID(),expectedRevision:1,generation,digest:await computeWholeRecordDigest([...snapshot.records.values()]),wireDigest:await wholeHash(hashes),parts,records:rows.length,device:'Synthetic large metadata QA',replace:true,outbox:outbox.map(row=>({key:row.key,operationId:row.operationId}))};
    const freezeStart=performance.now();await freezeWholeUpload(db,frozen,snapshot.state.commitId);const freezeMs=performance.now()-freezeStart;
    const fields={begin:[['p_operation_id','uuid'],['p_expected_revision','bigint'],['p_parts','integer'],['p_records','integer'],['p_digest','text'],['p_device','text'],['p_replace','boolean']],part:[['p_commit_id','uuid'],['p_operation_id','uuid'],['p_number','integer'],['p_raw','text']],finish:[['p_operation_id','uuid']]};
    const calls=[];let lostPart=true,lostFinish=true;
    const transport={async whole(name,body){if(waitingSince!==undefined){metrics.progressBoundaryMs+=performance.now()-waitingSince;waitingSince=undefined}const signature=fields[name],args=[connection.syncId,...signature.map(([key])=>body[key])];const result=(await pg.query(`select public.quiz_whole_${name}($1::text${signature.map(([,type],i)=>`,$${i+2}::${type}`).join('')}) result`,args)).rows[0].result;calls.push({name,id:body.p_operation_id,number:body.p_number,hash:body.p_raw?await wholeHash(body.p_raw):undefined});if(name==='part'&&lostPart){lostPart=false;throw Error('lost part response')}if(name==='finish'&&lostFinish){lostFinish=false;throw Error('lost finish response')}if(name==='part')waitingSince=performance.now();return result}};
    const restart=async()=>{const name=db.name;db.close();db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})};
    const guards={assertCurrent:async()=>{}};measuring=true;const sendStart=performance.now();
    await assert.rejects(sendFrozenWhole(db,transport,guards,frozen),/lost part response/);
    await restart();let resumed=await readWholeMeta(db,'wholeFrozen',connection);assert.equal(resumed.nextPart??0,0);
    assert.equal(await sendFrozenWhole(db,transport,guards,resumed),'more');resumed=await readWholeMeta(db,'wholeFrozen',connection);assert.equal(resumed.nextPart,20);
    await restart();resumed=await readWholeMeta(db,'wholeFrozen',connection);
    await assert.rejects(sendFrozenWhole(db,transport,guards,resumed,512),/lost finish response/);assert.equal((await readWholeMeta(db,'wholeFrozen',connection)).nextPart,parts.length);
    await restart();resumed=await readWholeMeta(db,'wholeFrozen',connection);assert.equal(await sendFrozenWhole(db,transport,guards,resumed),'committed');const sendMs=performance.now()-sendStart;measuring=false;
    assert.equal(await readWholeMeta(db,'wholeFrozen',connection),undefined);assert.equal((await readAppOutbox(db)).length,0);assert.equal(await readUserEditGeneration(db),generation);
    const first=calls.filter(call=>call.name==='part'&&call.number===0);assert.equal(first.length,2);assert.equal(first[0].id,first[1].id);assert.equal(first[0].hash,first[1].hash);
    const cloud=[];let after='';for(;;){const page=(await pg.query('select public.quiz_whole_read($1,2,$2,200) result',[connection.syncId,after])).rows[0].result;assert.equal(page.code,'ok');cloud.push(...page.rows);if(!page.hasMore)break;after=page.afterKey}
    assert.equal((await hydrateChunkChanges(db,cloud,connection,true)).find(row=>row.id===key).logicalRaw,raw);
    const baseline=process.env.QUIZ_WHOLE_PROGRESS_BASELINE==='true';if(!baseline){assert.ok(metrics.progressBytes<=parts.length*1024);assert.equal(metrics.progressWrites,parts.length);}
    const report={mode:baseline?'before':'after',metadataBytes:Buffer.byteLength(raw),wireBytes:groups.reduce((sum,raw)=>sum+Buffer.byteLength(raw),0),parts:parts.length,records:rows.length,freezeMs,sendMs,...metrics,progressBoundaryExcludingAccountingMs:Math.max(0,metrics.progressBoundaryMs-metrics.accountingMs),restartCount:3,lostPartReplayed:true,lostCommittedFinishRecovered:true,completeContentVerified:true,boundary:'Synthetic data, fake IndexedDB and serialized local PGlite using unchanged whole SQL; no live Auth, concurrent PostgreSQL or native disk timing.'};
    if(process.env.QUIZ_WHOLE_PROGRESS_REPORT)await writeFile(process.env.QUIZ_WHOLE_PROGRESS_REPORT,JSON.stringify(report,null,2)+'\n');
    console.log('WHOLE_PROGRESS_MEASUREMENT '+JSON.stringify(report));
  }finally{IDBObjectStore.prototype.put=originalPut;IDBObjectStore.prototype.get=originalGet;db?.close();await pg.close()}
});
