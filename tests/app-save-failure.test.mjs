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
const stamp='2026-10-04T00:00:00Z';
function bank(count,prefix){return {version:1,folders:[{id:prefix+'-f',name:'Synthetic fixture',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:prefix+'-s',folderId:prefix+'-f',title:'Synthetic bank',source:'mock; not the user bank',createdAt:stamp,updatedAt:stamp}],questions:Array.from({length:count},(_,i)=>({id:prefix+'-q'+i,setId:prefix+'-s',question:'Synthetic vocabulary '+i,choices:['answer','choice1','choice2','choice3','choice4'],answerIndex:0,explanation:'Synthetic explanation. '.repeat(8),distractors:['option5','option6','option7','option8','option9','option10'],shuffleChoices:true,createdAt:stamp,updatedAt:stamp})),progress:[],answerLogs:[]}}
async function reset(){const db=await storage.openAppDb();forceCloseDatabase(db);await new Promise(r=>setTimeout(r,0));globalThis.indexedDB=new IDBFactory();values.clear();rejectFallback=rejectEpoch=false;resetDataCoordinationForTests()}
async function raw(store,key){const db=await storage.openAppDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store);const r=tx.objectStore(store).get(key);tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error)})}
async function rows(store){const db=await storage.openAppDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store);const r=tx.objectStore(store).getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error)})}
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
