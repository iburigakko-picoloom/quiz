import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb';
const hook=registerHooks({resolve(specifier,context,next){return next(/^\.\.?\//u.test(specifier)&&!/\.[cm]?[jt]sx?$/u.test(specifier)&&context.parentURL?.endsWith('.ts')?`${specifier}.ts`:specifier,context)}});
process.on('exit',()=>hook.deregister());
const values=new Map();let rejectFallback=false,rejectEpoch=false;
globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,removeItem:key=>values.delete(key),setItem(key,value){if(rejectFallback&&key.endsWith(':fallback-record')||rejectEpoch&&key==='quizMake:coord:appEpoch')throw new DOMException('synthetic storage denial',rejectEpoch==='SecurityError'?'SecurityError':'QuotaExceededError');values.set(key,String(value))}};
globalThis.window={dispatchEvent(){}};globalThis.indexedDB=new IDBFactory();
const storage=await import('../src/storage.ts');
const {resetDataCoordinationForTests}=await import('../src/utils/dataCoordination.ts');
const records=await import('../src/utils/appRecordStorage.ts');
const {appSaveFailure,appSaveFailureMessage}=await import('../src/utils/appSaveFailure.ts');
const {recordAnswer}=await import('../src/utils/quiz.ts');
const {resetSyncMetrics,getSyncMetrics}=await import('../src/utils/syncMetrics.ts');
const {shouldPruneQuestionImages}=await import('../src/utils/localQuestionImages.ts');
const stamp='2026-10-04T00:00:00Z';
function bank(count,prefix){return {version:1,folders:[{id:prefix+'-f',name:'Synthetic fixture',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:prefix+'-s',folderId:prefix+'-f',title:'Synthetic bank',source:'mock; not the user bank',createdAt:stamp,updatedAt:stamp}],questions:Array.from({length:count},(_,i)=>({id:prefix+'-q'+i,setId:prefix+'-s',question:'Synthetic vocabulary '+i,choices:['answer','choice1','choice2','choice3','choice4'],answerIndex:0,explanation:'Synthetic explanation. '.repeat(8),distractors:['option5','option6','option7','option8','option9','option10'],shuffleChoices:true,createdAt:stamp,updatedAt:stamp})),progress:[],answerLogs:[]}}
async function reset(){const db=await storage.openAppDb();forceCloseDatabase(db);await new Promise(r=>setTimeout(r,0));globalThis.indexedDB=new IDBFactory();values.clear();rejectFallback=rejectEpoch=false;resetDataCoordinationForTests()}
async function raw(store,key){const db=await storage.openAppDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store);const r=tx.objectStore(store).get(key);tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error)})}
async function rows(store){const db=await storage.openAppDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store);const r=tx.objectStore(store).getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error)})}

test('single-answer saves validate only the answered question, keep undo/outbox atomic and reuse the durable snapshot',async()=>{
  await reset();await storage.saveAppDataResult(bank(10000,'answer-fast'));
  const previous=await storage.loadAppDataAsync(),db=await storage.openAppDb();
  const beforeState=await raw('appRecordMeta','state'),beforeOps=await records.readAppOutbox(db);
  const result=recordAnswer(previous,previous.questions[0],[0],false,'fast-log');
  let unrelatedValidations=0,fullReads=0;
  const choices=previous.questions[9999].choices;
  Object.defineProperty(previous.questions[9999],'choices',{configurable:true,enumerable:true,get(){unrelatedValidations++;return choices}});
  const originalGetAll=IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll=function(...args){if(this.name==='appRecords')fullReads++;return originalGetAll.apply(this,args)};
  resetSyncMetrics();const started=performance.now();
  try{
    assert.deepEqual(await storage.saveAppDataResult(result.data,{answerChange:{previous,questionId:previous.questions[0].id,answerLogId:'fast-log'}}),{ok:true});
    assert.equal(unrelatedValidations,0);assert.equal(fullReads,0);assert.equal(getSyncMetrics().recordWrite.count,2);
    const snapshot=await records.readCurrentAppRecordSnapshot(db);
    assert.equal(fullReads,0);assert.equal(snapshot.state.revision,beforeState.revision+1);
  }finally{IDBObjectStore.prototype.getAll=originalGetAll;Object.defineProperty(previous.questions[9999],'choices',{configurable:true,enumerable:true,writable:true,value:choices})}
  const elapsedMs=performance.now()-started;
  const canonical=await storage.loadAppDataAsync();
  assert.equal(canonical.answerLogs.length,1);assert.equal(canonical.progress[0].answeredCount,1);
  assert.deepEqual((await records.readPreviousAppRecords(db)).data,previous);
  const priorByKey=new Map(beforeOps.map(row=>[row.key,row.operationId]));
  assert.deepEqual((await records.readAppOutbox(db)).filter(row=>priorByKey.get(row.key)!==row.operationId).map(row=>row.collection).sort(),['answerLogs','progress']);
  assert.equal(shouldPruneQuestionImages(previous.questions,result.data.questions),false);
  console.log('synthetic-answer-save '+JSON.stringify({questions:10000,elapsedMs:Math.round(elapsedMs),recordWrites:2,fullReads,unrelatedValidations}));
});

test('a failed answer commit and exhausted fallback retain the exact original; retry saves one answer only',async()=>{
  await reset();await storage.saveAppDataResult(bank(2,'answer-abort'));
  const previous=await storage.loadAppDataAsync(),db=await storage.openAppDb();
  const state=await raw('appRecordMeta','state'),outbox=await records.readAppOutbox(db);
  const answer=recordAnswer(previous,previous.questions[0],[0],false,'stable-answer');
  const hint={previous,questionId:previous.questions[0].id,answerLogId:'stable-answer'};
  const originalPut=IDBObjectStore.prototype.put;rejectFallback=true;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='appOutbox'&&args[0].collection==='answerLogs')throw new DOMException('synthetic answer abort','QuotaExceededError');return originalPut.apply(this,args)};
  let failed;try{failed=await storage.saveAppDataResult(answer.data,{answerChange:hint})}finally{IDBObjectStore.prototype.put=originalPut;rejectFallback=false}
  assert.equal(failed.ok,false);assert.equal(failed.failure.code,'quota');
  assert.deepEqual(await raw('appRecordMeta','state'),state);
  assert.deepEqual(await records.readAppOutbox(db),outbox);
  assert.deepEqual((await records.readAppRecords(db)).data,previous);
  assert.equal((await storage.saveAppDataResult(answer.data,{answerChange:hint})).ok,true);
  const saved=await storage.loadAppDataAsync();assert.equal(saved.answerLogs.length,1);assert.equal(saved.progress[0].answeredCount,1);
});

test('a changed answer target or commit is refused without writing a stale full fallback',async()=>{
  await reset();await storage.saveAppDataResult(bank(2,'answer-fence'));
  const previous=await storage.loadAppDataAsync(),db=await storage.openAppDb();
  const answer=recordAnswer(previous,previous.questions[0],[0],false,'stale-answer');
  const transaction=db.transaction.bind(db);let injected=false;
  db.transaction=(stores,mode,...rest)=>{
    if(mode==='readwrite'&&Array.isArray(stores)&&stores.includes('appOutbox')&&!injected){
      injected=true;const change=transaction('appRecordMeta','readwrite'),get=change.objectStore('appRecordMeta').get('state');
      get.onsuccess=()=>change.objectStore('appRecordMeta').put({...get.result,commitId:crypto.randomUUID()},'state');
    }
    return transaction(stores,mode,...rest);
  };
  let refused;try{refused=await storage.saveAppDataResult(answer.data,{answerChange:{previous,questionId:previous.questions[0].id,answerLogId:'stale-answer'}})}finally{db.transaction=transaction}
  assert.equal(refused.ok,false);assert.equal(refused.failure.code,'external_change');
  assert.equal(values.has('quiz-make-app-data-v1:fallback-record'),false);
  assert.deepEqual((await records.readAppRecords(db)).data,previous);
});

test('answer hints cannot omit content edits; ordinary validation still rejects invalid questions',async()=>{
  await reset();await storage.saveAppDataResult(bank(2,'answer-general'));
  const previous=await storage.loadAppDataAsync(),answer=recordAnswer(previous,previous.questions[0],[0],false,'general-answer');
  const invalid={...answer.data,questions:answer.data.questions.map((row,index)=>index===1?{...row,choices:['invalid']}:row)};
  const saved=await storage.saveAppDataResult(invalid,{answerChange:{previous,questionId:previous.questions[0].id,answerLogId:'general-answer'}});
  assert.equal(saved.ok,false);assert.equal(saved.failure.code,'invalid_data');
  assert.deepEqual(await storage.loadAppDataAsync(),previous);
  assert.equal(shouldPruneQuestionImages(previous.questions,previous.questions.map(row=>({...row}))),false);
  assert.equal(shouldPruneQuestionImages(previous.questions,previous.questions.slice(1)),true);
  assert.equal(shouldPruneQuestionImages(previous.questions,[{id:'replacement'},previous.questions[1]]),true);
});

test('an answer saved to fallback is preserved when the next answer restores primary storage',async()=>{
  await reset();await storage.saveAppDataResult(bank(2,'answer-fallback'));
  const previous=await storage.loadAppDataAsync(),answer=recordAnswer(previous,previous.questions[0],[0],false,'fallback-first');
  const originalPut=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='appOutbox'&&args[0].collection==='answerLogs')throw new DOMException('synthetic primary denial','QuotaExceededError');return originalPut.apply(this,args)};
  try{assert.equal((await storage.saveAppDataResult(answer.data,{answerChange:{previous,questionId:previous.questions[0].id,answerLogId:'fallback-first'}})).ok,true)}finally{IDBObjectStore.prototype.put=originalPut}
  const second=recordAnswer(answer.data,answer.data.questions[0],[0],false,'fallback-second');
  assert.equal((await storage.saveAppDataResult(second.data,{answerChange:{previous:answer.data,questionId:previous.questions[0].id,answerLogId:'fallback-second'}})).ok,true);
  const loaded=await storage.loadAppDataAsync();assert.equal(loaded.answerLogs.length,2);assert.equal(loaded.progress[0].answeredCount,2);
});
test('synthetic 695 questions coexist with 10000 saved questions and their answer history after reload',async()=>{
  await reset();const original=bank(10000,'existing');original.answerLogs=[{id:'kept-answer',questionId:'existing-q0',setId:'existing-s',folderId:'existing-f',selectedIndex:0,isCorrect:true,answeredAt:stamp}];
  assert.deepEqual(await storage.saveAppDataResult(original),{ok:true});const first=await storage.loadAppDataAsync();const added=bank(695,'new');const combined={version:1,...Object.fromEntries(['folders','problemSets','questions','progress','answerLogs'].map(name=>[name,[...first[name],...added[name]]]))};
  assert.deepEqual(await storage.saveAppDataResult(combined),{ok:true});const db=await storage.openAppDb();forceCloseDatabase(db);await new Promise(r=>setTimeout(r,0));const loaded=await storage.loadAppDataAsync();assert.equal(loaded.questions.length,10695);assert.deepEqual(loaded.answerLogs,first.answerLogs);assert.equal((await records.readAppOutbox(await storage.openAppDb())).filter(op=>op.collection==='questions').length,10695);
});
test('an actual IndexedDB write abort and exhausted fallback report both stages without partial commit',async()=>{
  await reset();assert.equal((await storage.saveAppDataResult(bank(695,'old'))).ok,true);const before=await storage.loadAppDataAsync();const state=await raw('appRecordMeta','state');const outbox=await records.readAppOutbox(await storage.openAppDb());
  const originalPut=IDBObjectStore.prototype.put;let writes=0;rejectFallback=true;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='appOutbox'&&++writes===20)throw new DOMException('synthetic transaction failure','DataCloneError');return originalPut.apply(this,args)};
  let result;try{const added=bank(695,'add');result=await storage.saveAppDataResult({...before,folders:[...before.folders,...added.folders],problemSets:[...before.problemSets,...added.problemSets],questions:[...before.questions,...added.questions]})}finally{IDBObjectStore.prototype.put=originalPut;rejectFallback=false}
  assert.equal(result.ok,false);assert.deepEqual(result.failure,{code:'storage_write',attempts:[{stage:'indexeddb',errorName:'DataCloneError'},{stage:'fallback',errorName:'QuotaExceededError'}]});assert.equal((await raw('appRecordMeta','state')).commitId,state.commitId);assert.deepEqual(await storage.loadAppDataAsync(),before);assert.deepEqual(await records.readAppOutbox(await storage.openAppDb()),outbox);
});
test('quota while reserving cross-tab metadata is distinguishable and never bypasses the guard',async()=>{
  await reset();rejectEpoch=true;const result=await storage.saveAppDataResult(bank(695,'new'));rejectEpoch=false;assert.equal(result.ok,false);assert.deepEqual(result.failure,{code:'quota',attempts:[{stage:'coordination',errorName:'QuotaExceededError'}]});assert.equal(await raw('appRecordMeta','state'),undefined);
});
test('browser storage denial and cross-tab lock timeout remain distinct and do not create records',async t=>{
  await reset();rejectEpoch='SecurityError';const blocked=await storage.saveAppDataResult(bank(695,'new'));rejectEpoch=false;assert.equal(blocked.failure.code,'storage_blocked');assert.deepEqual(blocked.failure.attempts,[{stage:'coordination',errorName:'SecurityError'}]);assert.equal(await raw('appRecordMeta','state'),undefined);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request(_name,{signal}){return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('lock wait aborted','AbortError')),{once:true}))}}}});
  t.mock.timers.enable({apis:['setTimeout']});
  try{const save=storage.saveAppDataResult(bank(695,'new'));for(let n=0;n<20;n++)await Promise.resolve();t.mock.timers.tick(20000);const timedOut=await save;assert.equal(timedOut.failure.code,'lock_timeout');assert.deepEqual(timedOut.failure.attempts,[{stage:'coordination',errorName:'DataLockTimeoutError'}]);assert.equal(await raw('appRecordMeta','state'),undefined)}
  finally{t.mock.timers.reset();if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator}
});
test('external tab change is distinguished from storage capacity and preserves current records',async()=>{
  await reset();await storage.saveAppDataResult(bank(1,'saved'));const before=await storage.loadAppDataAsync();values.set('quizMake:coord:appEpoch','a-different-tab');const result=await storage.saveAppDataResult(bank(695,'new'));assert.equal(result.ok,false);assert.equal(result.failure.code,'external_change');assert.equal(result.failure.attempts[0].stage,'coordination');assert.deepEqual((await records.readAppRecords(await storage.openAppDb())).data,before);
});
test('invalid data and concurrent successful saves keep independent results',async()=>{
  await reset();const invalid=bank(695,'invalid');invalid.questions[694].choices=['only one'];const [bad,good]=await Promise.all([storage.saveAppDataResult(invalid),storage.saveAppDataResult(bank(695,'valid'))]);assert.equal(bad.ok,false);assert.equal(bad.failure.code,'invalid_data');assert.deepEqual(good,{ok:true});assert.equal((await storage.loadAppDataAsync()).questions.length,695);
});
test('diagnostics expose safe stage/name only and do not disclose user text or credentials',()=>{
  const failure=appSaveFailure([{stage:'indexeddb',error:new Error('Bearer private-token; question secret text')}]);const message=appSaveFailureMessage(failure);assert.doesNotMatch(JSON.stringify(failure)+message,/private-token|secret text|Bearer/);assert.doesNotMatch(message,/空き容量/);assert.match(message,/indexeddb\/Error/);
  const invalid=appSaveFailure([{stage:'validation',error:new Error('invalid')}],'questions に重複ID「malicious」private-token」があります。');assert.doesNotMatch(JSON.stringify(invalid)+appSaveFailureMessage(invalid),/private-token|malicious/);
});
test('appending a created bank avoids rewriting old questions and progress while preserving bank display order',async()=>{
  const evidence=[];
  for(const prependQuestions of [true,false]){
    await reset();await storage.saveAppDataResult(bank(10000,'existing'));const before=await storage.loadAppDataAsync(),previous=await records.readAppOutbox(await storage.openAppDb());const added=bank(695,'new');added.problemSets[0].folderId='existing-f';
    const after={...before,problemSets:[added.problemSets[0],...before.problemSets],questions:prependQuestions?[...added.questions,...before.questions]:[...before.questions,...added.questions]};
    const originalPut=IDBObjectStore.prototype.put;let oldQuestionWrites=0,recordWrites=0;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='appRecords'){recordWrites++;if(['questions','progress'].includes(args[0].collection)&&args[0].id.startsWith('existing-q'))oldQuestionWrites++}return originalPut.apply(this,args)};
    const start=performance.now();try{assert.equal((await storage.saveAppDataResult(after)).ok,true)}finally{IDBObjectStore.prototype.put=originalPut}
    const current=await records.readAppOutbox(await storage.openAppDb()),backups=await rows('appRecordBackups');const retained=await storage.loadAppDataAsync();assert.equal(retained.questions.length,10695);assert.equal(retained.problemSets[0].id,'new-s');assert.deepEqual(retained.questions.filter(q=>q.setId==='new-s').map(q=>q.id),added.questions.map(q=>q.id));
    if(!prependQuestions){assert.equal(oldQuestionWrites,0);const currentByKey=new Map(current.map(op=>[op.key,op]));for(const op of previous.filter(op=>['questions','progress'].includes(op.collection)))assert.equal(currentByKey.get(op.key).operationId,op.operationId);assert.equal(backups.filter(row=>['questions','progress'].includes(row.collection)).length,0)}else assert.equal(oldQuestionWrites,20000);
    evidence.push({questionPlacement:prependQuestions?'prepend-before-fix':'append-after-fix',existingQuestions:10000,addedQuestions:695,oldQuestionWrites,recordWrites,backupRecords:backups.length,backupBytes:new TextEncoder().encode(JSON.stringify(backups)).byteLength,elapsedMs:Math.round(performance.now()-start)});
  }
  console.log('synthetic-save-write-comparison '+JSON.stringify(evidence));
});
