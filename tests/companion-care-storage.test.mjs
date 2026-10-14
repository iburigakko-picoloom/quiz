import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { COMPANION_CARE_KEY, COMPANION_CARE_EVENT } from '../src/utils/companionCare.ts';
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
  assert.equal(care.food, 3); assert.equal(care.answerRemainder, 1);
  const trained = await saveCompanionCare(logs(151), { action: { kind: 'train', trickId: 'spin' }, now });
  assert.equal(trained.food, 2); assert.equal(trained.tricks.spin, 1); assert.equal(trained.friendship, 3);
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

test('aborted training rolls back the food, bond, mastery and outbox together; retry spends exactly one food', async () => {
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
  assert.equal(next.food, before.food - 1); assert.equal(next.tricks.spin, before.tricks.spin + 1);
});

test('concurrent actions are serialized and cannot spend one food twice', async () => {
  const before = readCompanionCare(); assert.equal(before.food, 1);
  const results = await Promise.allSettled([saveCompanionCare(logs(151), { action: { kind: 'feed' }, now }), saveCompanionCare(logs(151), { action: { kind: 'feed' }, now })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(readCompanionCare().food, 0);
  assert.equal(readCompanionCare().friendship, before.friendship + 4);
  assert.equal(accountLocalStorage.getItem(COMPANION_CARE_KEY), JSON.stringify(readCompanionCare()));
});

test('automatic care waits for conflict selection, frozen uploads and navigation, then credits each answer once', async () => {
  const before = readCompanionCare(), generation = await readUserEditGeneration(db), revision = getLocalDataRevision();
  const later = new Date('2026-10-15T05:00:00Z');
  const meta = async (key, value) => { const tx = db.transaction('appRecordMeta', 'readwrite');
    if (value) tx.objectStore('appRecordMeta').put(value, key); else tx.objectStore('appRecordMeta').delete(key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); };
  for (const key of ['wholeConflict', 'wholeFrozen']) {
    await meta(key, { pending: true });
    assert.deepEqual(await saveCompanionCare(logs(201), { automatic: true, visit: true, now: later }), before);
    assert.equal(await readUserEditGeneration(db), generation); assert.equal(getLocalDataRevision(), revision);
    await meta(key, null);
  }
  setSyncInteractionProtected(true);
  try { assert.deepEqual(await saveCompanionCare(logs(201), { automatic: true, visit: true, now: later }), before); }
  finally { setSyncInteractionProtected(false); }
  assert.deepEqual(await saveCompanionCare(logs(201), { automatic: true, isCurrent: () => false, visit: true, now: later }), before);
  assert.equal(await readUserEditGeneration(db), generation);
  const resumed = await saveCompanionCare(logs(201), { automatic: true, isCurrent: () => true, visit: true, now: later });
  assert.equal(resumed.food, before.food + 1); assert.equal(resumed.lastSeenDay, '2026-10-15');
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
  assert.equal((await saveCompanionCare(logs(251), { now })).food, 1);
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
  assert.equal(migrated.version, 2); assert.equal(migrated.food, 2); assert.equal(migrated.answerRemainder, 1);
  assert.deepEqual(migrated.rewardBaseline, { answers: 40, awards: 2 });
  assert.equal((await row('appRecords', appRecordKey('localStorage', COMPANION_CARE_KEY))).raw, JSON.stringify(migrated));
  assert.equal(await readUserEditGeneration(db), generation + 1);
  await saveCompanionCare(logs(41), { automatic: true, now });
  assert.equal(await readUserEditGeneration(db), generation + 1);
});
