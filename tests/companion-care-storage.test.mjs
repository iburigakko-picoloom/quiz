import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { COMPANION_CARE_KEY, COMPANION_CARE_EVENT, companionFoodAvailable, companionTreatsAvailable } from '../src/utils/companionCare.ts';
import { saveCompanionCare, readCompanionCare } from '../src/utils/companionCareStorage.ts';
import { createEmptyAppData, saveAppData, openAppDb, loadAppDataAsync } from '../src/storage.ts';
import { appRecordKey } from '../src/utils/appRecordStorage.ts';
import { readLearningValues } from '../src/utils/learningValueStorage.ts';
import { readUserEditGeneration } from '../src/utils/userEditGeneration.ts';
import { accountLocalStorage, publishLearningStorage } from '../src/utils/accountStorage.ts';
import { replayLocalStorageProjections, saveSyncedLocalStorage } from '../src/utils/localStorageRecords.ts';
import { createCompleteFileBackup } from '../src/utils/backupPayload.ts';
import { exportQuizMakeData } from '../src/utils/syncService.ts';
import { getLocalDataRevision } from '../src/utils/localDataRevision.ts';
import { setSyncInteractionProtected } from '../src/utils/syncInteraction.ts';

const values = new Map(), events = [];
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
globalThis.window = { dispatchEvent: event => events.push(event.type) };
await saveAppData(createEmptyAppData());
const db = await openAppDb();
after(() => db.close());
const logs = (count) => Array.from({ length: count }, (_, i) => ({ id: `saved-${i}` }));
const now = new Date('2026-10-14T05:00:00Z');
const row = async (store, key) => { const tx = db.transaction(store), r = tx.objectStore(store).get(key); await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); return r.result; };

test('food, remainder, duplicate witnesses and mastery persist in IDB and synchronized record with backup support', async () => {
  const care = await saveCompanionCare(logs(151), { visit: true, now });
  assert.equal(companionFoodAvailable(care), 3); assert.equal(care.answerRemainder, 1);
  await saveSyncedLocalStorage({[COMPANION_CARE_KEY]: JSON.stringify({...care,friendship:40,peakFriendship:40})});
  const trained = await saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'spin' }, now });
  assert.equal(companionFoodAvailable(trained), 2); assert.equal(trained.answerBalance, 126); assert.equal(trained.tricks.spin, 1); assert.equal(trained.friendship, 40);
  assert.deepEqual(readCompanionCare(), trained);
  const raw = JSON.stringify(trained);
  assert.equal((await readLearningValues(db)).get(COMPANION_CARE_KEY).raw, raw);
  assert.equal((await row('appRecords', appRecordKey('localStorage', COMPANION_CARE_KEY))).raw, raw);
  assert.equal((await row('appOutbox', appRecordKey('localStorage', COMPANION_CARE_KEY))).raw, raw);
  assert.equal(values.has(COMPANION_CARE_KEY), false, 'no native localStorage quota dependency');
  const backup = await createCompleteFileBackup(await exportQuizMakeData(), []);
  assert.equal(backup.localStorage[COMPANION_CARE_KEY], raw);
  assert.ok(events.includes(COMPANION_CARE_EVENT));
});

test('reopening/deleted logs retain balances; unchanged reconciliation does not make new dirty edits', async () => {
  const before = readCompanionCare(), generation = await readUserEditGeneration(db), revision = getLocalDataRevision();
  assert.deepEqual(await saveCompanionCare([], { visit: true, now }), before);
  assert.deepEqual(await saveCompanionCare(logs(151), { visit: true, now }), before);
  assert.equal(await readUserEditGeneration(db), generation); assert.equal(getLocalDataRevision(), revision);
  // Rehydrate the synchronous cache after a simulated restart.
  publishLearningStorage(new Map());
  await replayLocalStorageProjections(db);
  assert.deepEqual(readCompanionCare(), before);
});

test('aborted training retains food, treats, bond, mastery and outbox; retry spends one treat', async () => {
  const before = readCompanionCare(), beforeOutbox = await row('appOutbox', appRecordKey('localStorage', COMPANION_CARE_KEY));
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === 'appData' && value?.key === COMPANION_CARE_KEY) throw new DOMException('fixture quota', 'QuotaExceededError');
    return original.call(this, value, ...args);
  };
  try { await assert.rejects(saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'spin' }, now }), /fixture quota/); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(readCompanionCare(), before);
  assert.deepEqual(await row('appOutbox', appRecordKey('localStorage', COMPANION_CARE_KEY)), beforeOutbox);
  const next = await saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'spin' }, now });
  assert.equal(next.food, before.food); assert.equal(next.answerBalance, before.answerBalance - 25); assert.equal(next.tricks.spin, before.tricks.spin + 1);
});

test('concurrent training is serialized and cannot spend one treat twice', async () => {
  await saveCompanionCare(logs(151), { action: { kind: 'feed' }, now });
  await saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'touch' }, now });
  const before = readCompanionCare(); assert.equal(companionTreatsAvailable(before), 1);
  const results = await Promise.allSettled([saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'bow' }, now }), saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'bow' }, now })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(readCompanionCare().food, before.food); assert.equal(readCompanionCare().answerBalance, 1);
  assert.equal(readCompanionCare().friendship, before.friendship);
  assert.equal(accountLocalStorage.getItem(COMPANION_CARE_KEY), JSON.stringify(readCompanionCare()));
});

test('automatic care waits for conflict selection, frozen uploads and navigation, then credits each answer once', async () => {
  const before = readCompanionCare(), generation = await readUserEditGeneration(db), revision = getLocalDataRevision();
  const later = new Date('2026-10-15T05:00:00Z');
  const meta = async (key, value) => { const tx = db.transaction('appRecordMeta', 'readwrite');
    if (value) tx.objectStore('appRecordMeta').put(value, key); else tx.objectStore('appRecordMeta').delete(key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); };
  for (const key of ['wholeConflict', 'wholeFrozen', 'deltaFrozen']) {
    await meta(key, { pending: true });
    assert.deepEqual(await saveCompanionCare(logs(201), { automatic: true, visit: true, now: later }), before);
    assert.equal(await readUserEditGeneration(db), generation); assert.equal(getLocalDataRevision(), revision);
    await assert.rejects(saveCompanionCare(logs(201), { action: { kind: 'feed' }, now: later }), /同期の確認/);
    assert.deepEqual(readCompanionCare(), before);
    await meta(key, null);
  }
  setSyncInteractionProtected(true);
  try { assert.deepEqual(await saveCompanionCare(logs(201), { automatic: true, visit: true, now: later }), before); }
  finally { setSyncInteractionProtected(false); }
  assert.deepEqual(await saveCompanionCare(logs(201), { automatic: true, isCurrent: () => false, visit: true, now: later }), before);
  assert.equal(await readUserEditGeneration(db), generation);
  const resumed = await saveCompanionCare(logs(201), { automatic: true, isCurrent: () => true, visit: true, now: later });
  assert.equal(resumed.answerBalance, before.answerBalance + 50); assert.equal(resumed.lastSeenDay, '2026-10-15');
  assert.equal(await readUserEditGeneration(db), generation + 1);
  await saveCompanionCare(logs(201), { automatic: true, visit: true, now: later });
  assert.equal(await readUserEditGeneration(db), generation + 1); assert.deepEqual(readCompanionCare(), resumed);
});

test('reset is atomic, keeps study data, and survives reload without rewarding pre-reset answers again', async () => {
  const before = readCompanionCare(), studyBefore = await loadAppDataAsync();
  const outboxBefore = await row('appOutbox', appRecordKey('localStorage', COMPANION_CARE_KEY));
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === 'appData' && value?.key === COMPANION_CARE_KEY) throw new DOMException('fixture quota', 'QuotaExceededError');
    return put.call(this, value, ...args);
  };
  try { await assert.rejects(saveCompanionCare(logs(201), { action: { kind: 'reset' }, now }), /fixture quota/); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(readCompanionCare(), before);
  assert.deepEqual(await row('appOutbox', appRecordKey('localStorage', COMPANION_CARE_KEY)), outboxBefore);
  const reset = await saveCompanionCare(logs(201), { action: { kind: 'reset' }, now });
  assert.equal(reset.food, 0); assert.equal(reset.friendship, 0); assert.equal(reset.tricks.spin, 0);
  assert.equal(reset.creditedAnswerIds.length, 201);
  assert.deepEqual(await loadAppDataAsync(), studyBefore);
  publishLearningStorage(new Map()); await replayLocalStorageProjections(db);
  assert.deepEqual(readCompanionCare(), reset);
  assert.deepEqual(await saveCompanionCare(logs(201), { now }), reset);
  assert.equal(companionFoodAvailable(await saveCompanionCare(logs(251), { now })), 1);
});

test('legacy migration is saved once through the normal sync path and defers while a source choice is pending', async () => {
  const { rewardBaseline, ...current } = readCompanionCare();
  const legacy = { ...current, version: 1, creditedAnswerIds: logs(41).map(log => log.id), foodAwardAnswerIds: ['saved-19', 'saved-39'], food: 2, answerRemainder: 1 };
  const raw = JSON.stringify(legacy);
  await saveSyncedLocalStorage({ [COMPANION_CARE_KEY]: raw });
  const generation = await readUserEditGeneration(db);
  const pending = db.transaction('appRecordMeta', 'readwrite'); pending.objectStore('appRecordMeta').put({ pending: true }, 'wholeConflict');
  await new Promise((resolve, reject) => { pending.oncomplete = resolve; pending.onabort = () => reject(pending.error); });
  await saveCompanionCare(logs(41), { automatic: true, now });
  assert.equal((await readLearningValues(db)).get(COMPANION_CARE_KEY).raw, raw);
  assert.equal(await readUserEditGeneration(db), generation);
  const clear = db.transaction('appRecordMeta', 'readwrite'); clear.objectStore('appRecordMeta').delete('wholeConflict');
  await new Promise((resolve, reject) => { clear.oncomplete = resolve; clear.onabort = () => reject(clear.error); });
  const migrated = await saveCompanionCare(logs(41), { automatic: true, now });
  assert.equal(migrated.version, 4); assert.equal(migrated.food, 2); assert.equal(migrated.answerRemainder, 1);
  assert.deepEqual(migrated.rewardBaseline, { answers: 40, awards: 2 });
  assert.equal((await row('appRecords', appRecordKey('localStorage', COMPANION_CARE_KEY))).raw, JSON.stringify(migrated));
  assert.equal(await readUserEditGeneration(db), generation + 1);
  await saveCompanionCare(logs(41), { automatic: true, now });
  assert.equal(await readUserEditGeneration(db), generation + 1);
});

test('explicit conflict recovery keeps chosen care and both spend ledgers, resumes, and backup restore cannot revive spent answers',async()=>{
 const {createCompanionCare,creditCompanionAnswers,applyCompanionCareAction}=await import('../src/utils/companionCare.ts');
 const {resolveCompanionBudgetConflict,readCompanionBudgetConflicts}=await import('../src/utils/companionBudgetRecovery.ts');
 const {restoreFileBackup}=await import('../src/utils/backupPayload.ts');
 const base={...creditCompanionAnswers(createCompanionCare('2026-10-14'),logs(50)),friendship:40,peakFriendship:40};
 await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify(base)});
 const backup=await createCompleteFileBackup(await exportQuizMakeData(),[]);
 const left=applyCompanionCareAction(base,{kind:'feed'},'2026-10-14'),right=applyCompanionCareAction(base,{kind:'train',trickId:'spin'},'2026-10-14');
 await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify(left)});
 const tx=db.transaction('appRecordConflicts','readwrite');tx.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',local:{raw:JSON.stringify(left)},remote:{raw:JSON.stringify(right)}},'fixture-budget');
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
 assert.equal((await readCompanionBudgetConflicts()).length,1);
 await resolveCompanionBudgetConflict('fixture-budget','remote');
 const merged=readCompanionCare();assert.equal(merged.answerBalance,-25);assert.equal(merged.tricks.spin,1);assert.equal(merged.spendEvents.length,2);
 assert.equal((await readCompanionBudgetConflicts()).length,0);
 Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1024*1024*1024,usage:0})},configurable:true});
 const restored=await restoreFileBackup(backup);assert.equal(restored.ok,true,restored.error);
 assert.equal(readCompanionCare().answerBalance,-25);assert.equal(readCompanionCare().spendEvents.length,2);
 const resumed=await saveCompanionCare([...logs(50),...Array.from({length:50},(_,i)=>({id:`repay-${i}`}))],{now});
 assert.equal(resumed.answerBalance,25);
});

test('companion choice is scoped to the displayed connection and rejects a replaced candidate',async()=>{
 const {readCompanionBudgetConflicts,resolveCompanionBudgetConflict}=await import('../src/utils/companionBudgetRecovery.ts');
 const connection={project:'https://fixture.invalid',userId:'user-a',syncId:'one'};
 const raw=JSON.stringify(readCompanionCare());
 const tx=db.transaction('appRecordConflicts','readwrite');
 tx.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',connection,local:{raw},remote:{raw}},'scope-a');
 tx.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',connection:{...connection,syncId:'two'},local:{raw},remote:{raw}},'scope-b');
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
 const items=await readCompanionBudgetConflicts(connection);
 assert.deepEqual(items.map(item=>item.id),['scope-a']);
 const changed=db.transaction('appRecordConflicts','readwrite');
 changed.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',connection,local:{raw},remote:{raw:JSON.stringify({...readCompanionCare(),name:'new remote'})}},'scope-a');
 await new Promise((r,j)=>{changed.oncomplete=r;changed.onabort=()=>j(changed.error);});
 await assert.rejects(resolveCompanionBudgetConflict('scope-a','remote',items[0]),/競合の状態が変わりました/);
 assert.equal(JSON.stringify(readCompanionCare()),raw);
 assert.equal((await row('appRecordConflicts','scope-a')).resolvedAt,undefined);
});


test('choice previews use current friendship, preserve archived spends and reject changed local care',async()=>{
 const {readCompanionBudgetConflicts,resolveCompanionBudgetConflict,previewCompanionBudgetChoice}=await import('../src/utils/companionBudgetRecovery.ts');
 const original=readCompanionCare();
 const archived={...original,friendship:12,peakFriendship:60};
 const current={...original,friendship:55,peakFriendship:60};
 const remote={...original,friendship:30,peakFriendship:60};
 await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify(current)});
 const tx=db.transaction('appRecordConflicts','readwrite');
 tx.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',local:{raw:JSON.stringify(archived)},remote:{raw:JSON.stringify(remote)}},'fresh-choice');
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
 const item=(await readCompanionBudgetConflicts()).find(item=>item.id==='fresh-choice');
 assert.equal(previewCompanionBudgetChoice(item,'local').friendship,55);
 assert.equal(previewCompanionBudgetChoice(item,'remote').friendship,30);
 await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify({...current,friendship:56})});
 await assert.rejects(resolveCompanionBudgetConflict(item.id,'local',item),/競合の状態が変わりました/);
 const refreshed=(await readCompanionBudgetConflicts()).find(item=>item.id==='fresh-choice');
 const preview=previewCompanionBudgetChoice(refreshed,'local');
 await resolveCompanionBudgetConflict(refreshed.id,'local',refreshed);
 assert.deepEqual(readCompanionCare(),preview);
 assert.equal(readCompanionCare().friendship,56);
});

test('failure to mark a conflict resolved rolls back care and the outgoing edit together',async()=>{
 const {readCompanionBudgetConflicts,resolveCompanionBudgetConflict}=await import('../src/utils/companionBudgetRecovery.ts');
 const before=readCompanionCare(),raw=JSON.stringify(before);
 const outbox=await row('appOutbox',appRecordKey('localStorage',COMPANION_CARE_KEY));
 const tx=db.transaction('appRecordConflicts','readwrite');
 tx.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',local:{raw},remote:{raw:JSON.stringify({...before,friendship:23})}},'atomic-choice');
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
 const item=(await readCompanionBudgetConflicts()).find(item=>item.id==='atomic-choice');
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='appRecordConflicts'&&value?.resolvedAt){this.transaction.abort();return;}return put.call(this,value,...args);};
 try{await assert.rejects(resolveCompanionBudgetConflict(item.id,'remote',item));}finally{IDBObjectStore.prototype.put=put;}
 await replayLocalStorageProjections(db);
 assert.deepEqual(readCompanionCare(),before);
 assert.deepEqual(await row('appOutbox',appRecordKey('localStorage',COMPANION_CARE_KEY)),outbox);
 assert.equal((await row('appRecordConflicts',item.id)).resolvedAt,undefined);
 await resolveCompanionBudgetConflict(item.id,'remote',item);
 assert.equal(readCompanionCare().friendship,23);
});

test('recovery-required app data neither rewards nor mutates care and cannot appear synchronized',async()=>{
 const {APP_DATA_RECOVERY_REQUIRED_KEY}=await import('../src/storage.ts');
 const {syncStatusPresentation}=await import('../src/utils/syncStatusPresentation.ts');
 const {readRecordSyncStatus,recordSyncSummary}=await import('../src/utils/recordSyncStatus.ts');
 const before=readCompanionCare(),generation=await readUserEditGeneration(db);
 values.set(APP_DATA_RECOVERY_REQUIRED_KEY,JSON.stringify({version:1,reason:'backup-only'}));
 try{
  await assert.rejects(saveCompanionCare(logs(900),{automatic:true,visit:true,now}),/復旧確認/);
  await assert.rejects(saveCompanionCare([],{action:{kind:'pet'},now}),/復旧確認/);
  assert.deepEqual(readCompanionCare(),before);
  assert.equal(await readUserEditGeneration(db),generation);
  const status=await readRecordSyncStatus(db,{project:'fixture',userId:'user',syncId:'sync'});
  assert.equal(status.recoveryApp,true);
  assert.match(recordSyncSummary(status),/問題データの復旧確認/);
  assert.match(syncStatusPresentation({online:true,record:status,autoEnabled:true,recordEnabled:true,success:'saved',pending:false}).text,/問題データの復旧確認/);
 }finally{values.delete(APP_DATA_RECOVERY_REQUIRED_KEY);}
});


test('remote preview includes newer local spending and exactly matches the saved result',async()=>{
 const {createCompanionCare,creditCompanionAnswers,applyCompanionCareAction}=await import('../src/utils/companionCare.ts');
 const {readCompanionBudgetConflicts,resolveCompanionBudgetConflict,previewCompanionBudgetChoice}=await import('../src/utils/companionBudgetRecovery.ts');
 const base={...creditCompanionAnswers(createCompanionCare('2026-10-14'),logs(200)),friendship:60,peakFriendship:60};
 const left=applyCompanionCareAction(base,{kind:'feed'},'2026-10-14');
 const right=applyCompanionCareAction(base,{kind:'feed'},'2026-10-14');
 const current=applyCompanionCareAction(left,{kind:'feed'},'2026-10-14');
 await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify(current)});
 const tx=db.transaction('appRecordConflicts','readwrite');
 tx.objectStore('appRecordConflicts').put({kind:'companion-budget-conflict',local:{raw:JSON.stringify(left)},remote:{raw:JSON.stringify(right)}},'three-spends');
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
 const item=(await readCompanionBudgetConflicts()).find(item=>item.id==='three-spends');
 const preview=previewCompanionBudgetChoice(item,'remote');
 assert.equal(preview.answerBalance,50);
 assert.equal(preview.spendEvents.length,3);
 await resolveCompanionBudgetConflict(item.id,'remote',item);
 assert.deepEqual(readCompanionCare(),preview);
});

test('care-screen recovery defaults to the bound connection instead of another sync ID',async()=>{
 const {readCompanionBudgetConflicts}=await import('../src/utils/companionBudgetRecovery.ts');
 const binding={project:'https://fixture.invalid',userId:'user-a',syncId:'one'};
 const previous=await row('appRecordMeta','recordSyncConnection');
 const tx=db.transaction('appRecordMeta','readwrite');tx.objectStore('appRecordMeta').put(binding,'recordSyncConnection');
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});
 try{assert.deepEqual((await readCompanionBudgetConflicts()).map(item=>item.id),['scope-a']);}
 finally{const restore=db.transaction('appRecordMeta','readwrite');if(previous)restore.objectStore('appRecordMeta').put(previous,'recordSyncConnection');else restore.objectStore('appRecordMeta').delete('recordSyncConnection');await new Promise((r,j)=>{restore.oncomplete=r;restore.onabort=()=>j(restore.error);});}
});

test('verified delta sync reports pending work and completion with a retained backup warning', async () => {
 const {syncStatusPresentation}=await import('../src/utils/syncStatusPresentation.ts');
 const input={online:true,recordEnabled:true,autoEnabled:true,pending:false,success:'saved',record:{recoveryApp:true,deltaEnabled:true,pending:1}};
 assert.equal(syncStatusPresentation(input).text,'同期中');
 assert.equal(syncStatusPresentation({...input,record:{...input.record,pending:0}}).text,'学習データ同期済み');
});
