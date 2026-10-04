import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {after,test} from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
const hooks=registerHooks({resolve(s,c,next){return next(/^\.\.?\//u.test(s)&&! /\.[cm]?[jt]sx?$/u.test(s)&&c.parentURL?.endsWith('.ts')?s+'.ts':s,c)}});
after(()=>hooks.deregister());
const records=await import('../src/utils/appRecordStorage.ts');
const {queueAuxiliaryRecordWrite}=await import('../src/utils/auxiliaryRecordStorage.ts');
const {freezeRecordPushBatch,getPendingRecordPushBatch,bindRecordSyncConnection}=await import('../src/utils/recordSyncOutbox.ts');
const {runRecordSync}=await import('../src/utils/recordSyncEngine.ts');
const {SyncRecordTooLargeError,MAX_RECORD_BATCH_BYTES:limit}=await import('../src/utils/recordSyncSize.ts');
const {safeSyncFailureMessage}=await import('../src/utils/syncFailureDiagnostic.ts');
const {observeRecordSyncAttempt,publishSyncAttempt,publishSyncQueue,readSyncAttemptStatus,clearSyncAttemptStatus}=await import('../src/utils/syncAttemptStatus.ts');
const {createAutoSyncScheduler}=await import('../src/utils/autoSyncScheduler.ts');
const {readRecordSyncStatus,writeRecordSyncReceipt}=await import('../src/utils/recordSyncStatus.ts');
const connection={project:'https://test.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:'000000000000000000000000000000000001'};
const timestamp='2026-10-04T00:00:00.000Z',previousSuccess='2026-10-03T19:23:00.000Z';
const complete=tx=>new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error??Error('transaction aborted'))});
async function stored(db,store,key){const tx=db.transaction(store,'readonly'),done=complete(tx),request=tx.objectStore(store).get(key);await done;return request.result}
async function fixture(){
  const factory=new IDBFactory(),db=await new Promise((r,j)=>{const q=factory.open('size-test',7);q.onupgradeneeded=()=>records.upgradeAppRecordStores(q.result);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
  await records.saveAppRecords(db,{version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]},timestamp);
  await bindRecordSyncConnection(db,connection);await writeRecordSyncReceipt(db,connection,{status:'done',uploaded:0,downloaded:0},previousSuccess);return db;
}
function sizedOperation(wireSize,{collection='localStorage',id='quizMake:test:boundary',character='x'}={}){
  const op={operationId:'22222222-2222-4222-8222-222222222222',key:records.appRecordKey(collection,id),collection,id,raw:'',position:0,baseRevision:0,localRevision:1};
  const remaining=wireSize-(new TextEncoder().encode(JSON.stringify(op)).byteLength+1),size=new TextEncoder().encode(character).byteLength;
  op.raw=character.repeat(Math.floor(remaining/size))+'x'.repeat(remaining%size);assert.equal(new TextEncoder().encode(JSON.stringify(op)).byteLength+1,wireSize);return op;
}
async function putOperation(db,op){const tx=db.transaction(['appRecords','appOutbox'],'readwrite'),done=complete(tx);tx.objectStore('appOutbox').put(op,op.key);tx.objectStore('appRecords').put({key:op.key,collection:op.collection,id:op.id,raw:op.raw,position:op.position,serverRevision:0,localRevision:op.localRevision},op.key);await done}
async function assertRetained(db,op){assert.deepEqual((await records.readAppOutbox(db)).find(value=>value.key===op.key),op);assert.equal((await stored(db,'appRecords',op.key)).raw,op.raw);assert.equal((await readRecordSyncStatus(db,connection)).lastSuccessAt,previousSuccess)}
const transport=push=>({pull:async()=>({code:'ok',cursor:0,head:0,hasMore:false,batches:[]}),push});
const guards={assertCurrent:async()=>{},apply:op=>op()};

for(const wireSize of [limit-2,limit-1,limit,limit+1])test(`UTF-8 wire size ${wireSize} freezes a bounded batch or blocks while preserving its original`,async()=>{
  const db=await fixture(),op=sizedOperation(wireSize);
  try{
    await putOperation(db,op);
    if(wireSize+2<=limit){const batch=await freezeRecordPushBatch(db,connection);assert.equal(batch.operations.length,1);assert.deepEqual(batch.operations[0],op);assert.ok(new TextEncoder().encode(JSON.stringify(batch.operations)).byteLength<=limit)}
    else{await assert.rejects(freezeRecordPushBatch(db,connection),e=>e instanceof SyncRecordTooLargeError&&e.code==='payload_too_large'&&e.requiredBytes===wireSize+2);assert.equal(await getPendingRecordPushBatch(db,connection),null)}
    await assertRetained(db,op);
  }finally{db.close()}
});
test('oversized multibyte record pauses the real engine before Push without a retry timer or a new success receipt',async()=>{
  const db=await fixture(),op=sizedOperation(limit+1,{character:'問'});let pushes=0,calls=0,timerId=0;const timers=new Map();
  const clock={now:()=>0,setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)}};
  clearSyncAttemptStatus();await putOperation(db,op);
  const scheduler=createAutoSyncScheduler(async()=>{calls++;return(await observeRecordSyncAttempt(step=>runRecordSync(db,connection,transport(async()=>{pushes++;throw Error('unexpected Push')}),{...guards,step}),u=>publishSyncAttempt(connection,u))).outcome},clock,s=>publishSyncQueue(connection,s));
  try{
    scheduler.request(true);const scheduled=[...timers][0];assert.ok(scheduled);timers.delete(scheduled[0]);scheduled[1].fn();
    for(let n=0;n<200&&readSyncAttemptStatus(connection)?.phase!=='paused';n++)await new Promise(r=>setImmediate(r));
    const attempt=readSyncAttemptStatus(connection);assert.equal(attempt.phase,'paused');assert.equal(attempt.lastFailure.code,'payload_too_large');assert.equal(attempt.lastFailure.step,'push_prepare');assert.equal(attempt.retryAt,null);assert.equal(attempt.pauseReason,'payload_too_large');assert.equal(timers.size,0);assert.equal(calls,1);assert.equal(pushes,0);assert.equal(safeSyncFailureMessage(attempt.lastFailure.message),attempt.lastFailure.message);await assertRetained(db,op);
  }finally{scheduler.dispose();db.close();clearSyncAttemptStatus()}
});
test('small edit followed by oversized edit retains both originals when the freeze aborts',async()=>{
  const db=await fixture(),small=sizedOperation(600,{id:'quizMake:test:a-small'}),large=sizedOperation(limit+1,{id:'quizMake:test:z-large'});
  try{await putOperation(db,small);await putOperation(db,large);await assert.rejects(freezeRecordPushBatch(db,connection),e=>e.code==='payload_too_large');assert.equal(await getPendingRecordPushBatch(db,connection),null);await assertRetained(db,small);await assertRetained(db,large)}finally{db.close()}
});
test('uncertain existing request retains its exact body and IDs when a later edit is oversized',async()=>{
  const db=await fixture(),original=sizedOperation(600);
  try{await putOperation(db,original);const frozen=await freezeRecordPushBatch(db,connection);const later={...sizedOperation(limit+1),operationId:'33333333-3333-4333-8333-333333333333',localRevision:2};await putOperation(db,later);assert.deepEqual(await freezeRecordPushBatch(db,connection),frozen);await assertRetained(db,later)}finally{db.close()}
});
test('save immediately after an empty freeze returns more rather than done while its edit is pending',async()=>{
  const db=await fixture();let inserted=false,write,pushes=0;
  const proxy=new Proxy(db,{get(target,name){
    if(name==='transaction')return(...args)=>{const tx=target.transaction(...args);if(!inserted&&args[1]==='readonly'&&Array.isArray(args[0])&&args[0].length===2&&args[0].includes('appRecordMeta')&&args[0].includes('appOutbox'))tx.addEventListener('complete',()=>{inserted=true;const save=db.transaction(records.APP_RECORD_STORES,'readwrite');write=complete(save);queueAuxiliaryRecordWrite(save,'localStorage','quizMake:test:race',JSON.stringify('saved locally'))},{once:true});return tx};
    const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
  }});
  try{const result=await runRecordSync(proxy,connection,transport(async()=>{pushes++;throw Error('unexpected Push')}),guards);await write;assert.equal(inserted,true);assert.equal(pushes,0);assert.equal(result.status,'more');assert.equal((await records.readAppOutbox(db)).length,1);assert.equal((await readRecordSyncStatus(db,connection)).lastSuccessAt,previousSuccess)}finally{db.close()}
});
test('size diagnostics show only fixed kinds and bytes, never keys or arbitrary messages',()=>{
  for(const [collection,id,expected]of [
    ['localStorage','quizMake:plan:private-title','学習計画'],['indexedDbNotes','quizMake:notes:private-set:private-category','手書きノート'],['indexedDbNotes','quizMake:notes:private-set:__material_pdf_private-id','資料・ノート'],['localStorage','quiz-make-explanation-requests-v1','解説の依頼履歴'],['questions','private-question','問題'],['localStorage','quizMake:private-token','端末設定'],
  ]){const e=new SyncRecordTooLargeError(collection,id,1608955);assert.equal(e.recordKind,expected);assert.match(e.message,/1608955B/);assert.doesNotMatch(e.message,/private|Bearer|https:/);assert.equal(safeSyncFailureMessage(e.message),e.message);const unsafe=e.message.replace(expected,'private-answer');assert.equal(safeSyncFailureMessage(unsafe),'詳細な理由を安全に表示できません。端末データは保持しています。')}
  assert.equal(new SyncRecordTooLargeError('constructor','secret',1608955).recordKind,'端末設定');
  const sample=new SyncRecordTooLargeError('questions','secret',1608955).message;
  for(const invalid of [sample+' secret',sample.replace('1608955','160895500000000000'),sample.replace('1608955','800000'),sample.replace('921600B','2000000B')])assert.equal(safeSyncFailureMessage(invalid),'詳細な理由を安全に表示できません。端末データは保持しています。');
});
