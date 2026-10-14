import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { COMPANION_CARE_KEY, COMPANION_CARE_EVENT } from '../src/utils/companionCare.ts';
import { saveCompanionCare, readCompanionCare } from '../src/utils/companionCareStorage.ts';
import { createEmptyAppData, saveAppData, openAppDb } from '../src/storage.ts';
import { appRecordKey } from '../src/utils/appRecordStorage.ts';
import { readLearningValues } from '../src/utils/learningValueStorage.ts';
import { readUserEditGeneration } from '../src/utils/userEditGeneration.ts';
import { accountLocalStorage, publishLearningStorage } from '../src/utils/accountStorage.ts';
import { replayLocalStorageProjections } from '../src/utils/localStorageRecords.ts';
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
  const care = await saveCompanionCare(logs(61), { visit: true, now });
  assert.equal(care.food, 3); assert.equal(care.answerRemainder, 1);
  const trained = await saveCompanionCare(logs(61), { action: { kind: 'train', trickId: 'spin' }, now });
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
  assert.deepEqual(await saveCompanionCare(logs(61), { visit: true, now }), before);
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
  try { await assert.rejects(saveCompanionCare(logs(61), { action: { kind: 'train', trickId: 'spin' }, now }), /fixture quota/); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(readCompanionCare(), before);
  assert.deepEqual(await row('appOutbox', appRecordKey('localStorage', COMPANION_CARE_KEY)), beforeOutbox);
  const next = await saveCompanionCare(logs(61), { action: { kind: 'train', trickId: 'spin' }, now });
  assert.equal(next.food, before.food - 1); assert.equal(next.tricks.spin, before.tricks.spin + 1);
});

test('concurrent actions are serialized and cannot spend one food twice', async () => {
  const before = readCompanionCare(); assert.equal(before.food, 1);
  const results = await Promise.allSettled([saveCompanionCare(logs(61), { action: { kind: 'feed' }, now }), saveCompanionCare(logs(61), { action: { kind: 'feed' }, now })]);
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
    assert.deepEqual(await saveCompanionCare(logs(81), { automatic: true, visit: true, now: later }), before);
    assert.equal(await readUserEditGeneration(db), generation); assert.equal(getLocalDataRevision(), revision);
    await meta(key, null);
  }
  setSyncInteractionProtected(true);
  try { assert.deepEqual(await saveCompanionCare(logs(81), { automatic: true, visit: true, now: later }), before); }
  finally { setSyncInteractionProtected(false); }
  assert.deepEqual(await saveCompanionCare(logs(81), { automatic: true, isCurrent: () => false, visit: true, now: later }), before);
  assert.equal(await readUserEditGeneration(db), generation);
  const resumed = await saveCompanionCare(logs(81), { automatic: true, isCurrent: () => true, visit: true, now: later });
  assert.equal(resumed.food, before.food + 1); assert.equal(resumed.lastSeenDay, '2026-10-15');
  assert.equal(await readUserEditGeneration(db), generation + 1);
  await saveCompanionCare(logs(81), { automatic: true, visit: true, now: later });
  assert.equal(await readUserEditGeneration(db), generation + 1); assert.deepEqual(readCompanionCare(), resumed);
});
