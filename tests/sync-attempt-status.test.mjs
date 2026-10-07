import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {after,test} from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
const hooks=registerHooks({resolve(s,c,next){return next(/^\.\.?\//.test(s)&&! /\.[cm]?[jt]sx?$/.test(s)&&c.parentURL?.endsWith('.ts')?s+'.ts':s,c)}});
after(()=>hooks.deregister());
const {createAutoSyncScheduler}=await import('../src/utils/autoSyncScheduler.ts');
const {clearSyncAttemptStatus,readSyncAttemptStatus,publishSyncAttempt,publishSyncQueue,publishRemoteCheck,observeRecordSyncAttempt}=await import('../src/utils/syncAttemptStatus.ts');
const {SyncInterruptedError,SyncLocalPersistenceError,SyncProtocolError}=await import('../src/utils/syncInterruption.ts');
const {syncStatusPresentation}=await import('../src/utils/syncStatusPresentation.ts');
const {createRecordSyncRpc,RecordSyncRpcError}=await import('../src/utils/recordSyncNetwork.ts');
const {writeRecordSyncReceipt,readRecordSyncStatus}=await import('../src/utils/recordSyncStatus.ts');
const connection={project:'https://test.invalid',userId:'test-user',syncId:'test-sync'};
const base={now:0,online:true,loginRequired:false,error:true,autoEnabled:true,recordEnabled:true,record:{phase:'done',pending:0,staged:false,conflicts:0,lastSuccessAt:'2026-10-01T00:00:00Z',cursor:1},pending:false,success:'2026-10-01T00:00:00Z'};
const present=extra=>syncStatusPresentation({...base,attempt:readSyncAttemptStatus(connection),...extra});
const settle=async()=>{for(let n=0;n<30;n++)await Promise.resolve()};
function harness(run){
  clearSyncAttemptStatus();let now=0,id=0;const timers=new Map();
  const clock={now:()=>now,setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id},clearTimeout:id=>timers.delete(id)};
  const queue=createAutoSyncScheduler(async()=> (await observeRecordSyncAttempt(run,u=>publishSyncAttempt(connection,u),()=>new Date(now).toISOString())).outcome,clock,s=>publishSyncQueue(connection,s));
  return {queue,settle,now:()=>now,async advance(ms){const end=now+ms;for(let n=0;n<100;n++){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end){now=end;return}now=next[1].at;timers.delete(next[0]);next[1].fn();await settle()}throw Error('Runaway timer')}};
}
test('failure → delayed repeated retry → more → done uses current attempt instead of old errors or receipts',async()=>{
  let calls=0,release;const h=harness(async step=>{calls++;step('pull');if(calls===1)throw new RecordSyncRpcError('network','old failure');if(calls===2)return {status:'more'};await new Promise(r=>release=r);return {status:'done'}});
  h.queue.request(true);await h.advance(0);assert.equal(readSyncAttemptStatus(connection).lastFailure.step,'pull');assert.equal(present().text,'再試行を待っています');
  for(let n=0;n<10;n++)h.queue.request(true);await h.advance(4999);assert.equal(calls,1);await h.advance(1);assert.equal(calls,2);assert.equal(present().text,'同期を待っています');
  await h.advance(750);assert.equal(calls,3);assert.equal(present().text,'同期中');assert.equal(readSyncAttemptStatus(connection).lastFailure.message,'old failure');
  release();await settle();assert.equal(present().text,'同期済み');assert.equal(readSyncAttemptStatus(connection).lastFailure.code,'network');h.queue.dispose();
});
test('opening protected work during I/O pauses without backoff, then closes/resumes with the same request',async()=>{
  let calls=0,release;const h=harness(async()=>{calls++;if(calls===1){await new Promise(r=>release=r);throw new SyncInterruptedError('protected_work','safe pause')}return {status:'done'}});
  h.queue.request(true);await h.advance(0);release();await settle();assert.equal(present().text,'内容の確認後に同期を再開します');assert.equal(readSyncAttemptStatus(connection).lastFailure,null);assert.equal(readSyncAttemptStatus(connection).retryAt,null);
  await h.advance(60000);assert.equal(calls,1);h.queue.request(true);await h.advance(0);assert.equal(calls,2);assert.equal(present().text,'同期済み');h.queue.dispose();
});
test('a fresh Pull and queued run suppress a historical done receipt, while status read failure remains visible',async()=>{
  clearSyncAttemptStatus();publishSyncAttempt(connection,{phase:'done'});publishRemoteCheck(connection,true);assert.equal(present({error:false}).text,'同期中');publishRemoteCheck(connection,false);
  publishSyncQueue(connection,{phase:'queued',retryAt:null});assert.equal(present({error:false}).text,'同期を待っています');publishSyncQueue(connection,{phase:'running',retryAt:null});
  assert.equal(present({readError:true}).text,'同期状態を確認できません');assert.equal(present({loginRequired:true}).text,'同期中');
  publishSyncQueue(connection,{phase:'idle',retryAt:null});publishSyncAttempt(connection,{phase:'failed',lastFailure:{step:'remote_metadata',code:'authentication_required',at:'now',message:'login'}});assert.equal(present({loginRequired:false}).text,'ログインが必要です');
});
test('real RPC 401 and 429 preserve the error code and stage; backoff still prevents duplicate calls',async()=>{
  for(const [status,code,delay]of [[401,'authentication_required',5000],[429,'rate_limited',60000]]){
    let requests=0;const rpc=createRecordSyncRpc({url:connection.project,anonKey:'dummy',connection,access:async()=>({userId:connection.userId,accessToken:'dummy'}),assertCurrent(){},fetch:async()=>{requests++;return new Response('{}',{status})}});
    const h=harness(async step=>{step('pull');await rpc.pull(0);return {status:'done'}});h.queue.request(true);await h.advance(0);await settle();
    assert.equal(readSyncAttemptStatus(connection).lastFailure.code,code);assert.equal(readSyncAttemptStatus(connection).lastFailure.step,'pull');assert.equal(present().text,status===401?'ログインが必要です':'再試行を待っています');
    for(let n=0;n<5;n++)h.queue.request(true);await h.advance(delay-1);assert.equal(requests,1);await h.advance(1);assert.equal(requests,2);h.queue.dispose();
  }
});
test('timeout and an after-response protection guard retain their distinct failure/pause outcomes',async()=>{
  let blocked=false;const rpc=createRecordSyncRpc({url:connection.project,anonKey:'dummy',connection,access:async()=>({userId:connection.userId,accessToken:'dummy'}),assertCurrent(){if(blocked)throw new SyncInterruptedError('protected_work','pause')},fetch:async()=>{blocked=true;return new Response(JSON.stringify({code:'ok',cursor:0,head:0,hasMore:false,batches:[]}))}});
  const updates=[];let r=await observeRecordSyncAttempt(async step=>{step('pull');await rpc.pull(0);return {status:'done'}},u=>updates.push(u));assert.equal(r.outcome,'paused');assert.ok(r.error instanceof SyncInterruptedError);assert.ok(!updates.some(u=>u.lastFailure));
  const timeoutRpc=createRecordSyncRpc({url:connection.project,anonKey:'dummy',connection,timeoutMs:1,access:async()=>({userId:connection.userId,accessToken:'dummy'}),assertCurrent(){},fetch:async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))});
  r=await observeRecordSyncAttempt(async step=>{step('push');await timeoutRpc.push([]);return {status:'done'}},u=>updates.push(u));assert.equal(r.outcome,'retry');assert.equal(updates.at(-1).lastFailure.code,'timeout');assert.equal(updates.at(-1).lastFailure.step,'push');
});
test('attempts and failures never cross account, project or sync-ID scopes',()=>{
  clearSyncAttemptStatus();publishSyncAttempt(connection,{phase:'failed',lastFailure:{step:'pull',code:'network',at:'now',message:'private'}});
  for(const c of [{...connection,userId:'other'},{...connection,syncId:'other'},{...connection,project:'other'}])assert.equal(readSyncAttemptStatus(c),null);
  clearSyncAttemptStatus();assert.equal(readSyncAttemptStatus(connection),null);
});
test('real done receipt survives an informational status writer failure; display uses the receipt and live completion',async()=>{
  clearSyncAttemptStatus();const factory=new IDBFactory();const db=await new Promise((r,j)=>{const request=factory.open('receipt',1);request.onupgradeneeded=()=>{request.result.createObjectStore('appRecordMeta');request.result.createObjectStore('appOutbox');request.result.createObjectStore('appRecordConflicts')};request.onsuccess=()=>r(request.result);request.onerror=()=>j(request.error)});
  try{const tx=db.transaction('appRecordMeta','readwrite');tx.objectStore('appRecordMeta').put(connection,'recordSyncConnection');await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});
    const result=await observeRecordSyncAttempt(async step=>{step('receipt');await writeRecordSyncReceipt(db,connection,{status:'done',uploaded:0,downloaded:0},'2026-10-04T00:00:00Z');return {status:'done'}},u=>{publishSyncAttempt(connection,u);throw Error('informational writer quota')});
    assert.equal(result.outcome,'done');const record=await readRecordSyncStatus(db,connection);assert.equal(record.phase,'done');assert.equal(record.pending,0);assert.equal(present({record,success:record.lastSuccessAt,error:true}).text,'同期済み');
  }finally{db.close()}
});
test('local persistence and permanent protocol failures pause without a retry loop or invented success',async()=>{
  for(const error of [new SyncLocalPersistenceError('端末への保存を確認してください。'),new SyncProtocolError('invalid_response','差分読込のCursorが不正です。'),new RecordSyncRpcError('payload_too_large','too large')]){
    let calls=0,repaired=false;const h=harness(async step=>{calls++;step(error.code==='local_persistence_failed'?'local_persistence':'pull_validate');if(!repaired)throw error;return {status:'done'}});
    h.queue.request(true);await h.advance(0);assert.equal(readSyncAttemptStatus(connection).phase,'paused');assert.equal(readSyncAttemptStatus(connection).retryAt,null);assert.equal(present().action,'retry');assert.notEqual(present().text,'同期済み');
    await h.advance(180000);assert.equal(calls,1);repaired=true;h.queue.request(true);await h.advance(0);assert.equal(calls,2);assert.equal(present().text,'同期済み');h.queue.dispose();
  }
});
test('an expired retry time exposes an actionable state while offline and running retain priority',()=>{
  clearSyncAttemptStatus();publishSyncAttempt(connection,{phase:'failed',lastFailure:{step:'pull',code:'network',at:'now',message:'network'}});publishSyncQueue(connection,{phase:'queued',retryAt:5000});
  assert.equal(present({now:4999}).text,'再試行を待っています');assert.equal(present({now:4999}).action,'retry');assert.equal(present({now:20000}).text,'再試行できます');assert.equal(present({now:20000}).action,'retry');assert.equal(present({now:20000,online:false}).text,'オフライン');
  publishSyncQueue(connection,{phase:'running',retryAt:null});assert.equal(present({now:20000}).text,'同期中');assert.equal(present({now:20000}).action,null);
});

test('authentication in progress suppresses historical login and failure prompts',()=>{
  clearSyncAttemptStatus();publishSyncAttempt(connection,{phase:'running',step:'authentication',lastFailure:{step:'pull',code:'authentication_required',at:'old',message:'old'}});
  assert.equal(present({loginRequired:true}).text,'認証を確認しています');assert.equal(present().action,null);
  publishSyncAttempt(connection,{step:'pull'});assert.equal(present().text,'同期中');
});
test('403 permission failure pauses without login prompts; Auth transport failure retries without hiding the known account',async()=>{
  for(const [status,code]of [[403,'permission_denied'],[503,'network']]){
    const h=harness(async step=>{step('pull');const rpc=createRecordSyncRpc({url:'https://test.invalid',anonKey:'fixture',connection,access:async()=>({userId:connection.userId,accessToken:'fixture'}),assertCurrent(){},fetch:async()=>new Response('',{status})});await rpc.pull(0);return{status:'done'}});
    h.queue.request(true);await h.advance(0);const attempt=readSyncAttemptStatus(connection);assert.equal(attempt.lastFailure.code,code);assert.notEqual(present().action,'login');assert.equal(attempt.phase,status===403?'paused':'queued');if(status===403)assert.match(present().text,/権限/);h.queue.dispose();
  }
});
