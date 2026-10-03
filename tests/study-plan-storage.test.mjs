import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
const items = new Map();let deny=false;let denyCoord=false;let denyZone=false;
globalThis.localStorage={get length(){return items.size}, key:i=>[...items.keys()][i]??null,getItem:k=>items.get(k)??null,removeItem:k=>items.delete(k),setItem(k,v){if(deny&&k.startsWith('quizMake:plan:'))throw new Error('quota');if(denyCoord&&k==='quizMake:coord:noteEpoch')throw new Error('coord quota');if(denyZone&&k==='quizMake:studyTimeZone')throw new Error('timezone quota');items.set(k,String(v));}};
globalThis.window={dispatchEvent(){},addEventListener(){},removeEventListener(){},setTimeout,clearTimeout};
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const vite=await createServer({appType:'custom',logLevel:'silent',server:{middlewareMode:true}});after(()=>vite.close());
const storage=await vite.ssrLoadModule('/src/storage.ts');const plans=await vite.ssrLoadModule('/src/utils/studyPlans.ts');const planStorage=await vite.ssrLoadModule('/src/utils/studyPlanStorage.ts');
const records=await vite.ssrLoadModule('/src/utils/appRecordStorage.ts');const projections=await vite.ssrLoadModule('/src/utils/localStorageRecords.ts');const sync=await vite.ssrLoadModule('/src/utils/syncService.ts');
const q={id:'q',setId:'set',question:'What?',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'',category:'',difficulty:'basic',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
const app={version:1,folders:[{id:'f',name:'Folder',createdAt:q.createdAt,updatedAt:q.updatedAt}],problemSets:[{id:'set',folderId:'f',title:'English',source:'',createdAt:q.createdAt,updatedAt:q.updatedAt}],questions:[q],progress:[],answerLogs:[]};
const plan={schema:1,id:'p',title:'English',setId:'set',setTitle:'English',timeZone:'Asia/Tokyo',createdAt:q.createdAt,updatedAt:q.updatedAt,targets:plans.snapshotTargets([q],[]),schedules:[{effectiveDay:'2026-10-01',kind:'habit',deadline:'2026-10-31',weekdays:[0,1,2,3,4,5,6],holidays:[],dailyCounts:[1,1,1,1,1,1,1],paused:false}]};
test('plan, fixed days and timezone persist to the atomic record outbox, replay after projection failure, and reject concurrent overwrite',async()=>{
  assert.equal(await storage.saveAppData(app),true);deny=true;
  await assert.rejects(planStorage.savePlan(plan,null),/quota/);
  deny=false;await projections.replayLocalStorageProjections();assert.deepEqual(planStorage.readPlans(),[plan]);
  const db=await storage.openAppDb();const outbox=await records.readAppOutbox(db);assert.ok(outbox.some(o=>o.id===planStorage.PLAN_PREFIX+'p'&&o.collection==='localStorage'));
  await assert.rejects(planStorage.savePlan({...plan,title:'stale'},null),/別の操作/);
  await planStorage.ensurePlanDays([],new Date('2026-10-02T03:00:00Z'));const day=planStorage.readPlanDay(plan,new Date('2026-10-02T03:00:00Z'));assert.equal(day.goal,1);
  const log={id:'answer',questionId:'q',setId:'set',folderId:'f',selectedIndex:0,isCorrect:true,answeredAt:'2026-10-01T03:00:00Z',questionRevision:plans.questionRevision(q)};
  await planStorage.ensurePlanDays([log],new Date('2026-10-02T10:00:00Z'));assert.deepEqual(planStorage.readPlanDay(plan,new Date('2026-10-02T10:00:00Z')),day);
});
test('retrying an editor save recovers its exact committed attempt without duplicates or overwriting another edit',async()=>{
  const initialRaw=localStorage.getItem(planStorage.PLAN_PREFIX+'p');
  const retry={committedRaw:null};
  const attempted={...plan,title:'retry attempt'};deny=true;
  await assert.rejects(planStorage.savePlan(attempted,initialRaw,retry),/quota/);
  assert.equal(retry.committedRaw,JSON.stringify(attempted));
  await assert.rejects(planStorage.savePlan({...attempted,title:'still no cache space'},initialRaw,retry),/quota/);
  assert.equal(retry.committedRaw,JSON.stringify(attempted),'A pre-commit retry failure retains the last committed attempt');
  deny=false;
  const retried={...attempted,title:'retained draft after failure'};
  await planStorage.savePlan(retried,initialRaw,retry);
  assert.deepEqual(planStorage.readPlans(),[retried]);
  const currentRaw=JSON.stringify(retried);
  const otherEdit={...retried,title:'another editor'};
  await planStorage.savePlan(otherEdit,currentRaw);
  await assert.rejects(planStorage.savePlan({...retried,title:'stale retry'},initialRaw,retry),/別の操作/);
  assert.deepEqual(planStorage.readPlans(),[otherEdit]);
  await planStorage.savePlan(plan,JSON.stringify(otherEdit));
});
test('a new plan keeps its first committed createdAt after cache failure while updatedAt advances',async()=>{
  const retry={committedRaw:null};
  const first={...plan,id:'created-at-retry',createdAt:'2026-10-02T01:00:00Z',updatedAt:'2026-10-02T01:00:00Z'};
  deny=true;
  try { await assert.rejects(planStorage.savePlan(first,null,retry),/quota/); }
  finally { deny=false; }
  assert.equal(JSON.parse(retry.committedRaw).createdAt,first.createdAt);
  const later={...first,title:'retried later',createdAt:'2026-10-02T02:00:00Z',updatedAt:'2026-10-02T02:00:00Z'};
  await planStorage.savePlan(later,null,retry);
  const saved=JSON.parse(localStorage.getItem(planStorage.PLAN_PREFIX+first.id));
  assert.equal(saved.createdAt,first.createdAt);assert.equal(saved.updatedAt,later.updatedAt);
  assert.deepEqual(saved.targets,first.targets);assert.equal(saved.timeZone,first.timeZone);
  assert.equal(retry.committedRaw,JSON.stringify(saved));
  await planStorage.deletePlan(saved,retry.committedRaw);
});
test('a failure before commit leaves createdAt unfixed until a later successful attempt',async()=>{
  const retry={committedRaw:null};
  const first={...plan,id:'created-at-precommit',createdAt:'2026-10-02T01:00:00Z',updatedAt:'2026-10-02T01:00:00Z'};
  denyCoord=true;
  try { await assert.rejects(planStorage.savePlan(first,null,retry),/保存状態/); }
  finally { denyCoord=false; }
  assert.equal(retry.committedRaw,null);assert.equal(localStorage.getItem(planStorage.PLAN_PREFIX+first.id),null);
  const later={...first,createdAt:'2026-10-02T02:00:00Z',updatedAt:'2026-10-02T02:00:00Z'};
  await planStorage.savePlan(later,null,retry);
  assert.deepEqual(JSON.parse(localStorage.getItem(planStorage.PLAN_PREFIX+first.id)),later);
  await planStorage.deletePlan(later,retry.committedRaw);
});
test('without IndexedDB complete projections succeed but a partial timezone failure leaves one plan and rejects its retry',async()=>{
  const factory=globalThis.indexedDB;
  const existingRaw=localStorage.getItem(planStorage.PLAN_PREFIX+plan.id);
  const complete={...plan,id:'fallback-complete'};
  const partial={...plan,id:'fallback-partial'};
  const successfulRetry={committedRaw:null};const partialRetry={committedRaw:null};
  globalThis.indexedDB=undefined;
  try {
    await planStorage.savePlan(complete,null,successfulRetry);
    assert.equal(successfulRetry.committedRaw,JSON.stringify(complete));
    denyZone=true;
    await assert.rejects(planStorage.savePlan(partial,null,partialRetry),/timezone quota/);
    assert.equal(partialRetry.committedRaw,null);
    assert.equal(localStorage.getItem(planStorage.PLAN_PREFIX+partial.id),JSON.stringify(partial));
    denyZone=false;
    await assert.rejects(planStorage.savePlan({...partial,title:'partial retry'},null,partialRetry),/別の操作で計画が変更されました/);
    assert.equal(localStorage.getItem(planStorage.PLAN_PREFIX+partial.id),JSON.stringify(partial));
    assert.equal(localStorage.getItem(planStorage.PLAN_PREFIX+plan.id),existingRaw);
    assert.equal(planStorage.readPlans().filter(p=>p.id===partial.id).length,1);
  } finally {
    denyZone=false;globalThis.indexedDB=factory;
    items.delete(planStorage.PLAN_PREFIX+complete.id);items.delete(planStorage.PLAN_PREFIX+partial.id);
  }
});
test('full backup roundtrip restores plans and fixed days; malformed plan backups are rejected without replacing current data',async()=>{
  const backup=await sync.exportQuizMakeData();assert.ok(backup.localStorage[planStorage.PLAN_PREFIX+'p']);assert.equal(sync.validateSyncPayload(backup).ok,true);
  await planStorage.deletePlan(plan,localStorage.getItem(planStorage.PLAN_PREFIX+'p'));assert.deepEqual(planStorage.readPlans(),[]);
  const restored=await sync.importQuizMakeData(backup);assert.equal(restored.ok,true,restored.error);assert.equal(planStorage.readPlans()[0].id,'p');
  const bad={...backup,localStorage:{...backup.localStorage,[planStorage.PLAN_PREFIX+'p']:'{}'}};assert.equal(sync.validateSyncPayload(bad).ok,false);assert.equal((await sync.importQuizMakeData(bad)).ok,false);assert.equal(planStorage.readPlans()[0].id,'p');
});
