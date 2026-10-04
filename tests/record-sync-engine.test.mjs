import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { createRecordProtocolDatabase } from './helpers/record-protocol-db.mjs';

const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
    && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
after(() => hook.deregister());
const records = await import('../src/utils/appRecordStorage.ts');
const { runRecordSync } = await import('../src/utils/recordSyncEngine.ts');
const { getPendingRecordPushBatch, freezeRecordPushBatch, acknowledgeRecordPushBatch } = await import('../src/utils/recordSyncOutbox.ts');
const { applyStagedRecordPull, readActiveRecordConflicts, stageRecordPullPage } = await import('../src/utils/recordSyncPull.ts');
const { queueAuxiliaryRecordWrite } = await import('../src/utils/auxiliaryRecordStorage.ts');
const { prepareQuestionImageOutbox, prepareStagedQuestionImages } = await import('../src/utils/recordQuestionImageSync.ts');
const { describeQuestionImage } = await import('../src/utils/questionImageRecords.ts');
const { remoteQuestionImageDescriptor } = await import('../src/utils/questionImageCloud.ts');
const { prepareRecordMaterialOutbox } = await import('../src/utils/recordMaterialSync.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const { recordAnswer } = await import('../src/utils/quiz.ts');
const { readRecordSyncStatus, writeRecordSyncReceipt, recordSyncSummary } = await import('../src/utils/recordSyncStatus.ts');
const { runSelectedSync } = await import('../src/utils/syncRequest.ts');
const { readArchivedRecordConflicts, createConflictRecoveryCopy } = await import('../src/utils/recordConflictRecovery.ts');
const pg = await createRecordProtocolDatabase();
after(() => pg.close());
const timestamp = '2026-09-28T01:00:00.000Z';
const guards = { assertCurrent: async () => {}, apply: operation => operation() };
const editingGuards = { ...guards, apply: operation => operation({ preserveLiveData: true }) };
let sequence = 100;
async function database(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open('records', 4);
    request.onupgradeneeded = () => records.upgradeAppRecordStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function fixture({ syncDevices = true, questionCount = 1 } = {}) {
  const connection = { project: 'test', userId: '11111111-1111-1111-1111-111111111111', syncId: String(sequence++).padStart(36, '0') };
  const initial = normalizeAppData({ version: 1,
    folders: [{ id: 'f', name: 'Folder', createdAt: timestamp, updatedAt: timestamp }],
    problemSets: [{ id: 's', folderId: 'f', title: 'Set', source: '', createdAt: timestamp, updatedAt: timestamp }],
    questions: Array.from({ length: questionCount }, (_, index) => ({ id: index ? `q${index}` : 'q', setId: 's',
      question: `Question ${index + 1}`, choices: ['A','B','C','D'], answerIndex: 0, createdAt: timestamp, updatedAt: timestamp })),
    progress: [], answerLogs: [],
  }).data;
  const payload = { version: 1, updatedAt: timestamp, localStorage: { 'quiz-make-app-data-v1': JSON.stringify(initial) }, indexedDbNotes: {} };
  await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)', [connection.syncId, timestamp, JSON.stringify(payload)]);
  await pg.query('select public.quiz_sync_v2_open($1,$2)', [connection.syncId, timestamp]);
  const pushed = [];
  const transport = {
    async pull(cursor) { return (await pg.query('select public.quiz_sync_v2_pull($1,$2,20) as result', [connection.syncId, cursor])).rows[0].result; },
    async push(operations) {
      pushed.push(structuredClone(operations));
      return (await pg.query('select public.quiz_sync_v2_push($1,$2) as result', [connection.syncId, JSON.stringify(operations)])).rows[0].result;
    },
  };
  const factories = [new IDBFactory(), new IDBFactory()];
  const devices = await Promise.all(factories.map(database));
  for (const db of devices) {
    await records.saveAppRecords(db, initial, timestamp);
    if (syncDevices) {
      assert.equal((await runRecordSync(db, connection, transport, guards)).status, 'done');
      assert.equal((await records.readAppOutbox(db)).length, 0);
    }
  }
  assert.equal(pushed.length, 0, 'bootstrap reconciles semantically equal JSON without echo uploads');
  return { connection, initial, devices, factories, transport, pushed };
}
const read = async db => (await records.readAppRecords(db)).data;
const stored = async (db, store, key) => {
  const tx = db.transaction(store, 'readonly');
  const value = tx.objectStore(store).get(key);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  return value.result;
};
const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
async function auxiliary(db, collection, id, raw, primary) {
  const tx = db.transaction(records.APP_RECORD_STORES, 'readwrite'); const done = complete(tx);
  queueAuxiliaryRecordWrite(tx, collection, id, raw);
  if (primary) tx.objectStore(primary.store).put(primary.value, id);
  await done;
}
function answerTo(data, id) {
  Object.assign(data.progress[0], { answeredCount: 1, correctCount: 1, lastSelectedIndex: 0, lastAnswerCorrect: true, lastAnsweredAt: timestamp });
  data.answerLogs.push({ id, questionId: 'q', setId: 's', folderId: 'f', selectedIndex: 0, selectedIndexes: [0], isCorrect: true, answeredAt: timestamp });
  return data;
}
async function stageChanges(db, connection, changes) {
  const cursor = (await stored(db, 'appRecordMeta', 'pullCursor'))?.cursor ?? 0;
  await stageRecordPullPage(db, connection, cursor, { code: 'ok', cursor: cursor + 1, head: cursor + 1, hasMore: false,
    batches: [{ revision: cursor + 1, changes: changes.map(change => ({ ...change, key: records.appRecordKey(change.collection, change.id),
      position: 0, revision: cursor + 1 })) }] });
}

test('answers before the first V2 Pull rebase the verified initial progress without asking for a choice', async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    const initial = await read(a);
    const answer = recordAnswer(initial, initial.questions[0], [0], false, 'initial-answer').data;
    await records.saveAppRecords(a, answer, timestamp);
    const result = await runRecordSync(a, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'done');
    assert.equal(result.uploaded, 2);
    assert.deepEqual(await read(a), answer);
    assert.equal((await readActiveRecordConflicts(a, f.connection)).length, 0);
    await runRecordSync(b, f.connection, f.transport, guards);
    assert.deepEqual(await read(b), answer);
  } finally { a.close(); b.close(); }
});

async function retainedConflicts(db) {
  const tx = db.transaction('appRecordConflicts', 'readonly'); const done = complete(tx);
  const rows = tx.objectStore('appRecordConflicts').getAll(); await done;
  return rows.result;
}

test('six first-sync answers, including wrong answers, upload without six manual selections', async () => {
  const f = await fixture({ syncDevices: false, questionCount: 6 }); const [a,b] = f.devices;
  try {
    let answer = await read(a);
    for (const [index, question] of answer.questions.entries()) answer = recordAnswer(answer, question, [index % 2], false, `first-${index}`).data;
    await records.saveAppRecords(a, answer, timestamp);
    const result = await runRecordSync(a, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'done'); assert.equal(result.uploaded, 12);
    assert.deepEqual(await read(a), answer);
    assert.equal((await retainedConflicts(a)).filter(item => item.reason === 'bootstrap-answer-history').length, 6);
    assert.equal((await runRecordSync(b, f.connection, f.transport, guards)).status, 'done');
    assert.deepEqual(await read(b), answer);
  } finally { a.close(); b.close(); }
});

test('a shared prefix of bootstrap history sends only the new event and derived progress', async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    const shared = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'shared-prefix').data;
    const local = recordAnswer(shared, shared.questions[0], [1], false, 'new-after-prefix').data;
    await records.saveAppRecords(a, shared, timestamp); await records.saveAppRecords(b, local, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'done'); assert.equal(result.uploaded, 2);
    assert.deepEqual(await read(b), local);
    assert.equal(f.pushed.at(-1).filter(op => op.collection === 'answerLogs').length, 1);
    assert.equal(f.pushed.at(-1).find(op => op.collection === 'answerLogs').id, 'new-after-prefix');
    await runRecordSync(a, f.connection, f.transport, guards); assert.deepEqual(await read(a), local);
  } finally { a.close(); b.close(); }
});

test('bootstrap rebase quota failure rolls back metadata and outbox while preserving staged remote data', async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    await runRecordSync(a, f.connection, f.transport, guards);
    const remote = await read(a); remote.folders.push({ ...remote.folders[0], id: 'extra', name: 'Remote extra' });
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'quota-answer').data;
    await records.saveAppRecords(b, local, timestamp);
    const state = await stored(b, 'appRecordMeta', 'state'), outbox = await records.readAppOutbox(b);
    const realTransaction = b.transaction.bind(b);
    b.transaction = (...args) => {
      const tx = realTransaction(...args);
      if (args[1] === 'readwrite') {
        const realStore = tx.objectStore.bind(tx);
        tx.objectStore = name => { const store = realStore(name);
          if (name === 'appOutbox') store.put = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
          return store;
        };
      }
      return tx;
    };
    await assert.rejects(runRecordSync(b, f.connection, f.transport, editingGuards), { name: 'QuotaExceededError' });
    b.transaction = realTransaction;
    assert.deepEqual(await read(b), local); assert.deepEqual(await records.readAppOutbox(b), outbox);
    assert.deepEqual(await stored(b, 'appRecordMeta', 'state'), state);
    assert.equal(await stored(b, 'appRecordMeta', 'pullCursor'), undefined);
    assert.ok(await stored(b, 'appRecordMeta', 'pullStage'));
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).uploaded, 2);
  } finally { a.close(); b.close(); }
});

test('previously stored false conflicts recover after restart and retain the original competing versions', async () => {
  const f = await fixture({ syncDevices: false }); let [a,b] = f.devices;
  try {
    const original = await read(a);
    const answer = recordAnswer(original, original.questions[0], [0], false, 'recovered-first').data;
    await records.saveAppRecords(a, answer, timestamp);
    const page = await f.transport.pull(0); await stageRecordPullPage(a, f.connection, 0, page);
    const remote = page.batches[0].changes.find(row => row.collection === 'progress');
    const snapshot = await records.readAppRecordSnapshot(a);
    const operation = (await records.readAppOutbox(a)).find(op => op.collection === 'progress');
    const oldConflict = { key: remote.key, connection: f.connection, local: snapshot.records.get(remote.key), remote, operationId: operation.operationId };
    const tx = a.transaction('appRecordConflicts', 'readwrite'); const done = complete(tx);
    tx.objectStore('appRecordConflicts').put(oldConflict, remote.key); await done;
    const later = recordAnswer(answer, answer.questions[0], [1], false, 'recovered-second').data;
    await records.saveAppRecords(a, later, timestamp);
    forceCloseDatabase(a); a = await database(f.factories[0]);
    assert.equal((await runRecordSync(a, f.connection, f.transport, editingGuards)).status, 'done');
    assert.deepEqual(await read(a), later);
    assert.equal((await readActiveRecordConflicts(a, f.connection)).length, 0);
    const retained = await retainedConflicts(a);
    assert.ok(retained.some(item => item.reason === 'superseded' && item.conflict.local.raw === oldConflict.local.raw));
    assert.ok(retained.some(item => item.reason === 'bootstrap-answer-history' && item.eventIds.length === 2));
  } finally { a.close(); b.close(); }
});

for (const variation of ['missing-history', 'manual-flag', 'changed-count', 'reset']) test(`bootstrap ${variation} remains a retained conflict`, async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    const initial = await read(a);
    let answer = recordAnswer(initial, initial.questions[0], [0], false, 'history-required').data;
    await records.saveAppRecords(a, answer, timestamp);
    answer = structuredClone(answer);
    if (variation === 'missing-history') answer.answerLogs = [];
    if (variation === 'manual-flag') answer.progress[0].isAmbiguous = true;
    if (variation === 'changed-count') answer.progress[0].answeredCount = 5;
    if (variation === 'reset') answer.progress[0] = structuredClone(initial.progress[0]);
    await records.saveAppRecords(a, answer, timestamp);
    if (variation === 'reset') {
      const remoteAnswer = recordAnswer(f.initial, f.initial.questions[0], [1], false, 'remote-after-reset').data;
      await records.saveAppRecords(b, remoteAnswer, timestamp);
      await runRecordSync(b, f.connection, f.transport, guards);
    }
    const result = await runRecordSync(a, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'conflict'); assert.equal(result.uploaded, 0);
    assert.deepEqual(await read(a), answer); assert.ok((await records.readAppOutbox(a)).length);
    assert.ok((await readActiveRecordConflicts(a, f.connection)).some(item => item.remote.collection === 'progress'));
  } finally { a.close(); b.close(); }
});

test('a later cloud reset to zero is not mistaken for the original migration', async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    const answer = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'before-reset').data;
    await records.saveAppRecords(a, answer, timestamp);
    await f.transport.push([{ operationId: crypto.randomUUID(), key: records.appRecordKey('progress', 'q'), collection: 'progress', id: 'q',
      raw: JSON.stringify(f.initial.progress[0]), position: 0, baseRevision: 1 }]);
    assert.equal((await runRecordSync(a, f.connection, f.transport, editingGuards)).status, 'conflict');
    assert.deepEqual(await read(a), answer);
  } finally { a.close(); b.close(); }
});

test('complete bootstrap histories merge independent event IDs, defer live quiz changes, and replay a lost receipt once', async () => {
  const f = await fixture({ syncDevices: false }); let [a,b] = f.devices;
  try {
    const left = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'independent-a').data;
    const right = recordAnswer(f.initial, f.initial.questions[0], [1], false, 'independent-b').data;
    const laterTime = new Date(Date.parse(left.answerLogs[0].answeredAt) + 1000).toISOString();
    right.answerLogs[0].answeredAt = laterTime; right.progress[0].lastAnsweredAt = laterTime;
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const pushes = f.pushed.length;
    const protectedResult = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(protectedResult.status, 'deferred'); assert.equal(f.pushed.length, pushes);
    assert.deepEqual(await read(b), right); assert.ok(await stored(b, 'appRecordMeta', 'pullStage'));
    const unreliable = { ...f.transport, async push(operations) { await f.transport.push(operations); throw new Error('lost merged receipt'); } };
    await assert.rejects(runRecordSync(b, f.connection, unreliable, guards), /lost merged receipt/);
    const frozen = await getPendingRecordPushBatch(b, f.connection);
    const merged = await read(b);
    assert.equal(merged.progress[0].answeredCount, 2);
    assert.equal(merged.progress[0].correctCount, 1); assert.equal(merged.progress[0].wrongCount, 1);
    assert.deepEqual(new Set(merged.answerLogs.map(log => log.id)), new Set(['independent-a','independent-b']));
    assert.ok((await retainedConflicts(b)).some(item => item.choice === 'merged' && item.eventIds.length === 2));
    forceCloseDatabase(b); b = await database(f.factories[1]);
    assert.equal((await runRecordSync(b, f.connection, f.transport, guards)).status, 'done');
    assert.deepEqual(f.pushed.at(-1), frozen.operations);
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(a), merged); assert.deepEqual(await read(b), merged);
  } finally { a.close(); b.close(); }
});

test('independent equal-time answers merge only when their progress transitions commute', async () => {
  for (const differentOutcome of [false, true]) {
    const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
    try {
      const left = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'tied-a').data;
      const right = differentOutcome ? recordAnswer(f.initial, f.initial.questions[0], [1], false, 'tied-b').data : structuredClone(left);
      right.answerLogs[0].id = 'tied-b'; right.answerLogs[0].answeredAt = left.answerLogs[0].answeredAt;
      right.progress[0].lastAnsweredAt = left.progress[0].lastAnsweredAt;
      await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
      await runRecordSync(a, f.connection, f.transport, guards);
      const result = await runRecordSync(b, f.connection, f.transport, guards);
      assert.equal(result.status, differentOutcome ? 'conflict' : 'done');
      assert.equal((await read(b)).progress[0].answeredCount, differentOutcome ? 1 : 2);
      if (differentOutcome) assert.deepEqual(await read(b), right);
    } finally { a.close(); b.close(); }
  }
});

test('shared event IDs with an ambiguous equal-time order do not silently choose a branch', async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    const first = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'shared-order-first').data;
    const left = recordAnswer(first, first.questions[0], [1], false, 'shared-order-second').data;
    left.answerLogs.forEach(log => { log.answeredAt = timestamp; }); left.progress[0].lastAnsweredAt = timestamp;
    const right = structuredClone(left); right.answerLogs.reverse();
    right.progress[0].lastSelectedIndex = 0; right.progress[0].lastAnswerCorrect = true;
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'conflict'); assert.equal(result.uploaded, 0);
    assert.ok(result.conflicts.some(item => item.remote.collection === 'progress'));
    assert.deepEqual(await read(b), right);
  } finally { a.close(); b.close(); }
});

test('a shared answer event ID is acknowledged once while different payloads under that ID conflict', async () => {
  for (const changed of [false, true]) {
    const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
    try {
      const left = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'shared-event').data;
      const right = structuredClone(left);
      if (changed) right.answerLogs[0].presentedChoices[0] = 'Different event payload';
      await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
      await runRecordSync(a, f.connection, f.transport, guards);
      const result = await runRecordSync(b, f.connection, f.transport, guards);
      assert.equal(result.status, changed ? 'conflict' : 'done');
      assert.equal((await read(b)).progress[0].answeredCount, 1);
      assert.equal((await read(b)).answerLogs.length, 1);
      if (changed) assert.deepEqual(await read(b), right);
    } finally { a.close(); b.close(); }
  }
});

test('identical progress counters with incomplete post-bootstrap history still require a choice', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const left = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'same-count-a').data;
    const right = structuredClone(left); right.answerLogs[0].id = 'same-count-b';
    right.answerLogs = [];
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'conflict'); assert.equal(result.uploaded, 0);
    assert.ok(result.conflicts.some(item => item.remote.collection === 'progress'));
    assert.deepEqual(await read(b), right);
  } finally { a.close(); b.close(); }
});

test('complete later histories verify the shared ancestor, retain distinct events, and defer a live quiz merge', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-02T03:00:00.000Z') });
  const f = await fixture(); const [a, b] = f.devices;
  const answerAt = (data, id, selected, at) => {
    // Generate both the answer and its review transition at the event time.
    // Changing only lastAnsweredAt after recordAnswer leaves a real-clock
    // review level that cannot replay from this synthetic history.
    t.mock.timers.setTime(Date.parse(at));
    return recordAnswer(data, data.questions[0], [selected], false, id).data;
  };
  try {
    const shared = answerAt(f.initial, 'shared-later', 0, '2026-10-02T03:00:00.000Z');
    await records.saveAppRecords(a, shared, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    await runRecordSync(b, f.connection, f.transport, guards);
    const left = answerAt(await read(a), 'later-remote', 0, '2026-10-02T03:01:00.000Z');
    const right = answerAt(await read(b), 'later-local', 1, '2026-10-02T03:02:00.000Z');
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const pushes = f.pushed.length;
    const protectedResult = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(protectedResult.status, 'deferred'); assert.equal(f.pushed.length, pushes);
    assert.deepEqual(await read(b), right);
    const merged = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(merged.status, 'done');
    const data = await read(b);
    assert.equal(data.progress[0].answeredCount, 3); assert.equal(data.progress[0].correctCount, 2); assert.equal(data.progress[0].wrongCount, 1);
    assert.deepEqual(new Set(data.answerLogs.map(log => log.id)), new Set(['shared-later', 'later-remote', 'later-local']));
    assert.equal((await readActiveRecordConflicts(b, f.connection)).length, 0);
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual((await read(a)).progress, data.progress);
  } finally { a.close(); b.close(); }
});

test('V2 success and second sync retain their method and receipt without altering the legacy ancestor', async () => {
  const f = await fixture(); const [a, b] = f.devices;
  try {
    const legacy = { lastSyncAt: timestamp, lastSyncDigest: 'verified-snapshot' };
    const before = structuredClone(legacy);
    const execute = () => runSelectedSync(true, async () => {
      const result = await runRecordSync(a, f.connection, f.transport, guards);
      await writeRecordSyncReceipt(a, f.connection, result, '2026-10-02T04:00:00.000Z');
      return result;
    }, () => assert.fail('opted-in V2 must never route to Snapshot'));
    let local = recordAnswer(await read(a), f.initial.questions[0], [0], false, 'receipt-one').data;
    await records.saveAppRecords(a, local, timestamp); assert.equal((await execute()).status, 'done');
    let status = await readRecordSyncStatus(a, f.connection);
    assert.equal(status.pending, 0); assert.equal(status.lastSuccessAt, '2026-10-02T04:00:00.000Z'); assert.equal(recordSyncSummary(status), '同期済み');
    assert.deepEqual(legacy, before);
    local = recordAnswer(await read(a), f.initial.questions[0], [1], false, 'receipt-two').data;
    await records.saveAppRecords(a, local, timestamp); assert.equal((await readRecordSyncStatus(a, f.connection)).pending, 2);
    assert.equal((await execute()).status, 'done'); assert.deepEqual(legacy, before);
    status = await readRecordSyncStatus(a, f.connection);
    await writeRecordSyncReceipt(a, f.connection, { status: 'deferred', uploaded: 0, downloaded: 0 }, '2026-10-02T05:00:00.000Z');
    assert.equal((await readRecordSyncStatus(a, f.connection)).lastSuccessAt, status.lastSuccessAt);
    await assert.rejects(readRecordSyncStatus(a, { ...f.connection, userId: 'another-account' }), /別の接続/);
    assert.equal(recordSyncSummary({ ...status, phase: 'conflict', conflicts: 1, pending: 2 }), '確認が必要です。同期は完了していません');
  } finally { a.close(); b.close(); }
});

test('explicit conflict choices archive both originals and create validated separate recovery copies', async () => {
  const f = await fixture(); const [a, b] = f.devices;
  try {
    const left = await read(a), right = await read(b);
    left.questions[0].explanation = 'Cloud edit'; right.questions[0].explanation = 'Local edit';
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'conflict');
    const item = result.conflicts[0];
    const chosen = await applyStagedRecordPull(b, f.connection, [{ key: item.key, operationId: item.operationId, remoteRevision: item.remote.revision, choice: 'remote' }]);
    assert.equal(chosen.applied, true);
    const archives = await readArchivedRecordConflicts(b, f.connection);
    const saved = archives.find(archive => archive.conflict.local.raw === item.local.raw && archive.conflict.remote.raw === item.remote.raw);
    assert.ok(saved); const original = structuredClone(saved);
    const current = await read(b);
    for (const side of ['local', 'remote']) {
      const copy = createConflictRecoveryCopy(current, saved.conflict, side, timestamp);
      assert.equal(copy.questions.length, current.questions.length + 1);
      assert.deepEqual(copy.questions[0], current.questions[0]);
      assert.equal(copy.questions.at(-1).explanation, side === 'local' ? 'Local edit' : 'Cloud edit');
      assert.notEqual(copy.questions.at(-1).id, current.questions[0].id);
      assert.equal(copy.problemSets.at(-1).visibility, 'private');
      assert.ok(normalizeAppData(copy).ok);
    }
    assert.deepEqual(saved, original); assert.deepEqual(await read(b), current);
    assert.deepEqual(await readArchivedRecordConflicts(b, { ...f.connection, userId: 'another-account' }), []);
  } finally { a.close(); b.close(); }
});

test('an answer log acknowledged in an earlier batch still protects its unsent progress from an equal-counter remote answer', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const local = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'partial-local').data;
    await records.saveAppRecords(b, local, timestamp);
    const log = (await records.readAppOutbox(b)).find(op => op.collection === 'answerLogs');
    const batch = { id: crypto.randomUUID(), connection: f.connection, operations: [log] };
    const tx = b.transaction('appRecordMeta', 'readwrite'); const done = complete(tx);
    tx.objectStore('appRecordMeta').put(batch, 'pushBatch'); await done;
    const response = await f.transport.push(batch.operations); await acknowledgeRecordPushBatch(b, batch, response);
    const remote = structuredClone(local); remote.answerLogs[0].id = 'partial-remote';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'conflict'); assert.equal(result.uploaded, 0);
    assert.ok(result.conflicts.some(item => item.remote.collection === 'progress'));
    assert.deepEqual(await read(b), local);
  } finally { a.close(); b.close(); }
});

test('acknowledged ancestor content survives coalescing and permits a harmless newer remote revision', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    let answer = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'coalesced-first').data;
    await records.saveAppRecords(b, answer, timestamp);
    answer = recordAnswer(answer, answer.questions[0], [1], false, 'coalesced-second').data;
    await records.saveAppRecords(b, answer, timestamp);
    const progress = (await records.readAppOutbox(b)).find(op => op.collection === 'progress');
    assert.deepEqual(JSON.parse(progress.baseContent.raw), f.initial.progress[0]);
    await f.transport.push([{ operationId: crypto.randomUUID(), key: progress.key, collection: 'progress', id: 'q',
      raw: progress.baseContent.raw, position: 0, baseRevision: 1 }]);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).status, 'done');
    assert.deepEqual(await read(b), answer);
    assert.ok((await retainedConflicts(b)).some(item => item.reason === 'unchanged-ancestor'));
    assert.ok(f.pushed.every(batch => batch.every(op => !('baseContent' in op))), 'ancestor evidence never leaves the device');
  } finally { a.close(); b.close(); }
});

for (const collection of ['indexedDbNotes', 'localStorage']) test(`${collection} keeps its acknowledged ancestor across coalesced edits and harmless remote revisions`, async () => {
  const f = await fixture(); const [a,b] = f.devices;
  const id = collection === 'localStorage' ? 'quizMake:settings' : 'quizMake:notes:s:Cardio';
  const original = '{"text":"acknowledged"}', edited = '{"text":"second edit"}';
  try {
    await auxiliary(a, collection, id, original);
    await runRecordSync(a, f.connection, f.transport, guards);
    await runRecordSync(b, f.connection, f.transport, guards);
    const key = records.appRecordKey(collection, id), ancestor = await stored(b, 'appRecords', key);
    await auxiliary(b, collection, id, '{"text":"first edit"}');
    await auxiliary(b, collection, id, edited);
    await f.transport.push([{operationId:crypto.randomUUID(),key,collection,id,raw:original,position:0,baseRevision:ancestor.serverRevision}]);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'done');
    assert.equal((await stored(b, 'appRecords', key)).raw, edited);
    assert.equal((await records.readAppOutbox(b)).length, 0);
    assert.ok((await retainedConflicts(b)).some(item => item.reason === 'unchanged-ancestor'));
    assert.ok(f.pushed.every(batch => batch.every(op => !('baseContent' in op))), 'ancestor evidence stays local');
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.equal((await stored(a, 'appRecords', key)).raw, edited);
  } finally { a.close(); b.close(); }
});

test('an auxiliary ancestor never authorizes replacing a genuinely changed remote value', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  const collection = 'indexedDbNotes', id = 'quizMake:notes:s:Cardio';
  try {
    await auxiliary(a, collection, id, 'acknowledged');
    await runRecordSync(a, f.connection, f.transport, guards); await runRecordSync(b, f.connection, f.transport, guards);
    await auxiliary(a, collection, id, 'remote edit'); await auxiliary(b, collection, id, 'local edit');
    await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'conflict'); assert.equal(result.conflicts[0].remote.raw, 'remote edit');
    assert.equal(result.conflicts[0].local.raw, 'local edit'); assert.equal((await records.readAppOutbox(b)).length, 1);
  } finally { a.close(); b.close(); }
});

test('bootstrap metadata acknowledgements and answer rebases commit while an unrelated new folder stays staged', async () => {
  const f = await fixture({ syncDevices: false }); const [a,b] = f.devices;
  try {
    await runRecordSync(a, f.connection, f.transport, guards);
    const remote = await read(a); remote.folders.push({ ...remote.folders[0], id: 'new', name: 'Remote extra folder' });
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'staged-first-answer').data;
    await records.saveAppRecords(b, local, timestamp);
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'more'); assert.equal(result.uploaded, 2);
    assert.deepEqual(await read(b), local); assert.equal(await stored(b, 'appRecordMeta', 'pullCursor'), undefined);
    assert.equal((await records.readAppOutbox(b)).length, 0);
    await runRecordSync(b, f.connection, f.transport, guards); await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(a), await read(b)); assert.equal((await read(b)).folders.length, 2);
  } finally { a.close(); b.close(); }
});

test('a real question conflict does not keep a verified first-answer conflict in the selection list', async () => {
  const f = await fixture({ syncDevices: false, questionCount: 2 }); const [a,b] = f.devices;
  try {
    await runRecordSync(a, f.connection, f.transport, guards);
    const remote = await read(a); remote.questions[1].question = 'Remote edit';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = recordAnswer(f.initial, f.initial.questions[0], [0], false, 'safe-with-conflict').data;
    local.questions[1].question = 'Local edit'; await records.saveAppRecords(b, local, timestamp);
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'conflict'); assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].remote.collection, 'questions'); assert.deepEqual(await read(b), local);
    assert.equal((await readActiveRecordConflicts(b, f.connection)).length, 1);
    const pending = (await records.readAppOutbox(b)).find(op => op.collection === 'progress' && op.id === 'q');
    assert.equal(pending.baseRevision, 1);
    assert.ok((await retainedConflicts(b)).some(item => item.reason === 'bootstrap-answer-history'));
  } finally { a.close(); b.close(); }
});

test('Home-only guard reproduces stalled fresh upload; metadata-only Pull sends saved edits and answers during work', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const edited = await read(a); edited.questions[0].explanation = 'Saved while editing';
    await records.saveAppRecords(a, edited, timestamp);
    const stalled = await runRecordSync(a, f.connection, f.transport, { ...guards, apply: async () => null });
    assert.deepEqual(stalled, { status: 'deferred', uploaded: 0, downloaded: 0 });
    assert.equal(f.pushed.length, 0); assert.equal((await records.readAppOutbox(a)).length, 1);
    assert.equal((await runRecordSync(a, f.connection, f.transport, editingGuards)).uploaded, 1);
    assert.deepEqual(await read(a), edited);
    const answer = await read(a);
    Object.assign(answer.progress[0], { answeredCount: 1, correctCount: 1, lastSelectedIndex: 0, lastAnswerCorrect: true, lastAnsweredAt: timestamp });
    answer.answerLogs.push({ id: 'protected-answer', questionId: 'q', setId: 's', folderId: 'f', selectedIndex: 0, selectedIndexes: [0], isCorrect: true, answeredAt: timestamp });
    await records.saveAppRecords(a, answer, timestamp);
    const protectedApply = { ...editingGuards, async apply(operation) {
      const result = await operation({ preserveLiveData: true });
      assert.equal(result.applied, true); assert.equal(result.changed, 0);
      assert.equal(result.data, undefined, 'protected work never receives a replacement AppData');
      return result;
    } };
    assert.equal((await runRecordSync(a, f.connection, f.transport, protectedApply)).uploaded, 2);
    assert.equal((await records.readAppOutbox(a)).length, 0);
    await runRecordSync(b, f.connection, f.transport, guards);
    assert.deepEqual(await read(b), answer);
  } finally { a.close(); b.close(); }
});

test('unrelated remote edits stay staged while local edits upload; more editing and returning Home converge', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const remote = await read(a); remote.folders[0].name = 'Remote folder';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = await read(b); local.questions[0].question = 'Local editor';
    await records.saveAppRecords(b, local, timestamp);
    const cursor = await stored(b, 'appRecordMeta', 'pullCursor');
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'more'); assert.equal(result.uploaded, 1);
    assert.deepEqual(await read(b), local, 'neither React nor durable live data may change under the editor');
    assert.deepEqual(await stored(b, 'appRecordMeta', 'pullCursor'), cursor);
    assert.ok(await stored(b, 'appRecordMeta', 'pullStage'));
    const later = await read(b); later.questions[0].explanation = 'Another local edit';
    await records.saveAppRecords(b, later, timestamp);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).uploaded, 1);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).status, 'deferred');
    assert.deepEqual(await read(b), later);
    assert.equal((await runRecordSync(b, f.connection, f.transport, guards)).status, 'done');
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(a), await read(b));
    assert.equal((await read(b)).folders[0].name, 'Remote folder');
    assert.equal((await read(b)).questions[0].explanation, 'Another local edit');
  } finally { a.close(); b.close(); }
});

test('protected same-record conflict retains both versions before any fresh Push', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const remote = await read(a); remote.questions[0].question = 'Remote';
    const local = await read(b); local.questions[0].question = 'Offline editor';
    await records.saveAppRecords(a, remote, timestamp); await records.saveAppRecords(b, local, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const pushes = f.pushed.length;
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'conflict'); assert.equal(result.conflicts.length, 1);
    assert.equal(f.pushed.length, pushes); assert.deepEqual(await read(b), local);
    const conflicts = await readActiveRecordConflicts(b, f.connection);
    assert.equal(JSON.parse(conflicts[0].remote.raw).question, 'Remote');
    assert.equal(JSON.parse(conflicts[0].local.raw).question, 'Offline editor');
    assert.equal((await records.readAppOutbox(b)).length, 1);
  } finally { a.close(); b.close(); }
});

test('remote changes after protected Pull inspection are rejected by CAS and then become retained conflicts', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const local = await read(b); local.questions[0].question = 'Local';
    await records.saveAppRecords(b, local, timestamp);
    const concurrent = { ...f.transport, async push(operations) {
      const remote = await read(a); remote.questions[0].question = 'Changed after Pull';
      await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
      return f.transport.push(operations);
    } };
    const result = await runRecordSync(b, f.connection, concurrent, editingGuards);
    assert.equal(result.status, 'more'); assert.equal(result.uploaded, 0);
    assert.equal(await getPendingRecordPushBatch(b, f.connection), null);
    assert.equal((await records.readAppOutbox(b)).length, 1);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).status, 'conflict');
    assert.deepEqual(await read(b), local);
  } finally { a.close(); b.close(); }
});

test('protected staged Pull and lost receipt survive offline restart and newer local saves', async () => {
  const f = await fixture(); let [a,b] = f.devices;
  try {
    const remote = await read(a); remote.folders[0].name = 'Remote folder';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = await read(b); local.questions[0].question = 'First';
    await records.saveAppRecords(b, local, timestamp);
    const unreliable = { ...f.transport, async push(ops) { await f.transport.push(ops); throw new Error('offline after commit'); } };
    await assert.rejects(runRecordSync(b, f.connection, unreliable, editingGuards), /offline/);
    const frozen = await getPendingRecordPushBatch(b, f.connection);
    const stage = await stored(b, 'appRecordMeta', 'pullStage');
    assert.ok(stage); assert.ok(frozen);
    const later = await read(b); later.questions[0].question = 'Later';
    await records.saveAppRecords(b, later, timestamp);
    forceCloseDatabase(b); b = await database(f.factories[1]);
    const pushes = f.pushed.length;
    const resumed = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(resumed.uploaded, 2); assert.equal(resumed.status, 'more');
    assert.deepEqual(f.pushed[pushes], frozen.operations);
    assert.notEqual(f.pushed[pushes + 1][0].operationId, frozen.operations[0].operationId);
    assert.deepEqual(await read(b), later);
    assert.equal((await records.readAppOutbox(b)).length, 0);
    await runRecordSync(b, f.connection, f.transport, guards); await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(b), await read(a));
  } finally { a.close(); b.close(); }
});

test('a local save during protected Push is sent with a new ID after acknowledgement', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const first = await read(a); first.questions[0].explanation = 'First';
    await records.saveAppRecords(a, first, timestamp);
    let changed = false;
    const duringUpload = { ...f.transport, async push(operations) {
      if (!changed) {
        changed = true;
        const next = await read(a); next.questions[0].explanation = 'Saved during network I/O';
        await records.saveAppRecords(a, next, timestamp);
      }
      return f.transport.push(operations);
    } };
    assert.equal((await runRecordSync(a, f.connection, duringUpload, editingGuards)).uploaded, 2);
    assert.notEqual(f.pushed[0][0].operationId, f.pushed[1][0].operationId);
    assert.ok(f.pushed[1][0].baseRevision > f.pushed[0][0].baseRevision);
    assert.equal((await records.readAppOutbox(a)).length, 0);
    await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal((await read(b)).questions[0].explanation, 'Saved during network I/O');
  } finally { a.close(); b.close(); }
});

test('incomplete Pull, blocked apply and failed staged media never authorize fresh protected Push', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const local = await read(b); local.questions[0].explanation = 'Local pending';
    await records.saveAppRecords(b, local, timestamp);
    const pushes = f.pushed.length;
    const remote = await read(a); remote.folders[0].name = 'Remote';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const remote2 = await read(a); remote2.folders[0].name = 'Remote again';
    await records.saveAppRecords(a, remote2, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const paged = { ...f.transport, async pull(cursor) {
      return (await pg.query('select public.quiz_sync_v2_pull($1,$2,1) as result', [f.connection.syncId, cursor])).rows[0].result;
    } };
    const bounded = await runRecordSync(b, f.connection, paged, editingGuards, 1);
    assert.equal(bounded.status, 'more'); assert.equal(bounded.uploaded, 0);
    assert.equal(f.pushed.length, pushes + 2);
    const committedCursor = await stored(b, 'appRecordMeta', 'pullCursor');
    await assert.rejects(runRecordSync(b, f.connection, paged, {
      ...editingGuards, prepareMedia: async () => { throw new Error('image download failed'); },
    }), /image download failed/);
    assert.equal(f.pushed.length, pushes + 2);
    assert.deepEqual(await stored(b, 'appRecordMeta', 'pullCursor'), committedCursor);
    assert.ok(await stored(b, 'appRecordMeta', 'pullStage'));
    const blocked = await runRecordSync(b, f.connection, f.transport, { ...guards, apply: async () => null });
    assert.equal(blocked.status, 'deferred'); assert.equal(blocked.uploaded, 0);
    assert.equal((await records.readAppOutbox(b)).length, 1); assert.deepEqual(await read(b), local);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).uploaded, 1);
  } finally { a.close(); b.close(); }
});

test('a local save after inspection must be inspected again before the next batch can freeze', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const remote = await read(a); remote.folders[0].name = 'Remote';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = await read(b); local.questions[0].explanation = 'Local';
    await records.saveAppRecords(b, local, timestamp);
    const pushes = f.pushed.length;
    const concurrent = { ...editingGuards, async apply(operation) {
      const result = await operation({ preserveLiveData: true });
      assert.equal(result.deferred, true);
      const newer = await read(b); newer.folders[0].name = 'New edit after inspection';
      await records.saveAppRecords(b, newer, timestamp);
      return result;
    } };
    assert.equal((await runRecordSync(b, f.connection, f.transport, concurrent)).status, 'more');
    assert.equal(f.pushed.length, pushes); assert.equal(await getPendingRecordPushBatch(b, f.connection), null);
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'conflict'); assert.equal(f.pushed.length, pushes);
    assert.equal((await records.readAppOutbox(b)).length, 2);
    assert.equal((await read(b)).folders[0].name, 'New edit after inspection');
  } finally { a.close(); b.close(); }
});

test('remote deletion remains staged under a live quiz and a later answer cannot resurrect it', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const deleted = await read(a); deleted.questions = []; deleted.progress = [];
    await records.saveAppRecords(a, deleted, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = await read(b); local.folders[0].name = 'Local folder';
    await records.saveAppRecords(b, local, timestamp);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).uploaded, 1);
    assert.deepEqual(await read(b), local, 'current quiz data remains present on this device');
    const answered = answerTo(await read(b), 'answer-after-remote-delete');
    await records.saveAppRecords(b, answered, timestamp);
    const pushes = f.pushed.length;
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.status, 'conflict'); assert.equal(f.pushed.length, pushes);
    assert.deepEqual(await read(b), answered); assert.equal((await records.readAppOutbox(b)).length, 2);
    const remoteQuestion = await pg.query('select raw from private.quiz_sync_records where sync_id=$1 and collection=$2 and record_id=$3', [f.connection.syncId, 'questions', 'q']);
    assert.equal(remoteQuestion.rows[0].raw, null);
  } finally { a.close(); b.close(); }
});

test('remote deletion racing with answer Push rejects the entire CAS batch, including the new log', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const local = answerTo(await read(b), 'answer-delete-race');
    await records.saveAppRecords(b, local, timestamp);
    const concurrent = { ...f.transport, async push(operations) {
      const remote = await read(a); remote.questions = []; remote.progress = [];
      await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
      return f.transport.push(operations);
    } };
    const result = await runRecordSync(b, f.connection, concurrent, editingGuards);
    assert.equal(result.uploaded, 0); assert.equal(result.status, 'more');
    const rows = await pg.query('select count(*)::integer as count from private.quiz_sync_records where sync_id=$1 and record_id=$2', [f.connection.syncId, 'answer-delete-race']);
    assert.equal(rows.rows[0].count, 0, 'a stale progress write cannot partially commit a new log');
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).status, 'conflict');
    assert.deepEqual(await read(b), local);
  } finally { a.close(); b.close(); }
});

test('invalid remote dependencies stop inspection without changing local data, outbox or committed cursor', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const local = await read(b); local.questions[0].explanation = 'Must remain local';
    await records.saveAppRecords(b, local, timestamp);
    const pending = await records.readAppOutbox(b), cursor = await stored(b, 'appRecordMeta', 'pullCursor');
    await stageChanges(b, f.connection, [{ collection: 'problemSets', id: 's', raw: null }]);
    const stage = await stored(b, 'appRecordMeta', 'pullStage');
    const transport = { pull: async () => ({ code: 'ok', cursor: stage.cursor, head: stage.head, hasMore: false, batches: [] }),
      push: async () => assert.fail('invalid graph must never authorize a new batch') };
    await assert.rejects(runRecordSync(b, f.connection, transport, editingGuards), /参照|存在|失われ/);
    assert.deepEqual(await read(b), local); assert.deepEqual(await records.readAppOutbox(b), pending);
    assert.deepEqual(await stored(b, 'appRecordMeta', 'pullCursor'), cursor);
    assert.ok(await stored(b, 'appRecordMeta', 'pullStage')); assert.equal(await getPendingRecordPushBatch(b, f.connection), null);
  } finally { a.close(); b.close(); }
});

test('an external commit during inspection fails the commit CAS and keeps all pending data', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const remote = await read(a); remote.folders[0].name = 'Remote';
    await records.saveAppRecords(a, remote, timestamp); await runRecordSync(a, f.connection, f.transport, guards);
    const local = await read(b); local.questions[0].explanation = 'Local';
    await records.saveAppRecords(b, local, timestamp);
    const state = await stored(b, 'appRecordMeta', 'state');
    const transaction = b.transaction.bind(b); let injected = false;
    b.transaction = (stores, mode, ...rest) => {
      if (!injected && mode === 'readwrite' && Array.isArray(stores) && stores.includes('appRecordConflicts')) {
        injected = true;
        const concurrent = transaction('appRecordMeta', 'readwrite');
        concurrent.objectStore('appRecordMeta').put({ ...state, commitId: crypto.randomUUID() }, 'state');
      }
      return transaction(stores, mode, ...rest);
    };
    const pushes = f.pushed.length;
    await assert.rejects(runRecordSync(b, f.connection, f.transport, editingGuards), /端末が更新/);
    b.transaction = transaction;
    assert.equal(injected, true); assert.equal(f.pushed.length, pushes);
    assert.deepEqual(await read(b), local); assert.equal((await records.readAppOutbox(b)).length, 1);
    assert.equal((await runRecordSync(b, f.connection, f.transport, editingGuards)).uploaded, 1);
  } finally { a.close(); b.close(); }
});

test('remote notes and localStorage projections wait for Home without overwriting a newer local memo', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const note = 'quizMake:notes:protected', memo = 'quizMake:weaknessNotes:q';
    const prior = 'original note', remote = 'remote note', localMemo = '["original memo"]';
    for (const db of [a,b]) {
      await auxiliary(db, 'indexedDbNotes', note, prior, { store: 'categoryNotes', value: prior });
      await auxiliary(db, 'localStorage', memo, localMemo);
    }
    await runRecordSync(a, f.connection, f.transport, guards); await runRecordSync(b, f.connection, f.transport, guards);
    await auxiliary(a, 'indexedDbNotes', note, remote, { store: 'categoryNotes', value: remote });
    await auxiliary(a, 'localStorage', memo, '["remote memo"]');
    await runRecordSync(a, f.connection, f.transport, guards);
    const local = await read(b); local.questions[0].explanation = 'Local';
    await records.saveAppRecords(b, local, timestamp);
    const projection = await stored(b, 'localProjections', memo);
    const result = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(result.uploaded, 1); assert.equal(await stored(b, 'categoryNotes', note), prior);
    assert.equal(await stored(b, 'localProjections', memo), projection);
    assert.equal((await stored(b, 'appRecords', records.appRecordKey('indexedDbNotes', note))).raw, prior);
    await auxiliary(b, 'localStorage', memo, '["new local memo"]');
    const conflict = await runRecordSync(b, f.connection, f.transport, editingGuards);
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.conflicts[0].remote.raw, '["remote memo"]');
    assert.equal(conflict.conflicts[0].local.raw, '["new local memo"]');
    assert.equal(await stored(b, 'categoryNotes', note), prior);
  } finally { a.close(); b.close(); }
});

test('offline before server commit preserves an exact protected batch across crash/restart', async () => {
  const f = await fixture(); let [a,b] = f.devices;
  try {
    const local = await read(a); local.questions[0].explanation = 'Offline';
    await records.saveAppRecords(a, local, timestamp);
    await assert.rejects(runRecordSync(a, f.connection, { ...f.transport, push: async () => { throw new Error('offline before request'); } }, editingGuards), /offline/);
    const frozen = await getPendingRecordPushBatch(a, f.connection);
    forceCloseDatabase(a); a = await database(f.factories[0]);
    assert.equal((await runRecordSync(a, f.connection, f.transport, editingGuards)).uploaded, 1);
    assert.deepEqual(f.pushed[0], frozen.operations);
    await runRecordSync(b, f.connection, f.transport, guards); assert.deepEqual(await read(b), local);
    assert.equal((await records.readAppOutbox(a)).length, 0);
  } finally { a.close(); b.close(); }
});

test('new unprepared media never poison a frozen batch, and failed upload can retry without losing bytes', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const id = 'local-image', blob = new Blob(['saved image'], { type: 'image/png' });
    const image = { id, questionId: 'q', name: 'a.png', type: blob.type, blob, addedAt: timestamp };
    const descriptor = await describeQuestionImage(image), key = records.appRecordKey('questionImages', id);
    await auxiliary(a, 'questionImages', id, JSON.stringify(descriptor), { store: 'questionImageBlobs', value: image });
    const state = await stored(a, 'appRecordMeta', 'state'), originalOp = (await records.readAppOutbox(a))[0];
    await assert.rejects(runRecordSync(a, f.connection, f.transport, editingGuards), /保存が未確認/);
    assert.equal(await getPendingRecordPushBatch(a, f.connection), null);
    const transport = { userId: f.connection.userId, exists: async () => false, upload: async () => { throw new Error('Storage offline'); } };
    await assert.rejects(prepareQuestionImageOutbox(a, transport, async () => {}), /Storage offline/);
    assert.deepEqual((await records.readAppOutbox(a))[0], originalOp);
    assert.deepEqual(await stored(a, 'appRecordMeta', 'state'), state);
    assert.equal((await stored(a, 'questionImageBlobs', id)).blob.size, blob.size);
    await read(a); // Populate the cached record snapshot before Storage prepares the descriptor.
    assert.equal((await prepareQuestionImageOutbox(a, { ...transport, upload: async () => {} }, async () => {})).prepared, 1);
    assert.notEqual((await stored(a, 'appRecordMeta', 'state')).commitId, state.commitId);
    const prepared = await stored(a, 'appRecords', key);
    assert.ok(JSON.parse(prepared.raw).path);
    assert.equal((await records.readAppOutbox(a))[0].operationId, originalOp.operationId);
    await stageChanges(a, f.connection, [{ collection: 'questionImages', id, raw: prepared.raw }]);
    await prepareStagedQuestionImages(a, { ...transport, download: async () => assert.fail('verified local body is reusable') }, async () => {});
    const result = await applyStagedRecordPull(a, f.connection, [], { preserveLiveData: true });
    assert.equal(result.applied, true); assert.equal(result.changed, 0); assert.equal(result.data, undefined);
    assert.equal((await records.readAppOutbox(a)).length, 0, 'equal prepared media must not produce a false conflict');
    assert.equal((await stored(a, 'questionImageBlobs', id)).blob.size, blob.size);
  } finally { a.close(); b.close(); }
});

test('PDF preparation preserves local bytes and uncertain receipts before preparing newer files', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const id = 'quizMake:notes:s:__material_pdf_pdf';
    const raw = JSON.stringify({ kind: 'quiz-material-file', version: 1, materialId: 'pdf', updatedAt: timestamp,
      dataUrl: 'data:application/pdf;base64,' + Buffer.from('saved PDF').toString('base64') });
    await auxiliary(a, 'indexedDbNotes', id, raw, { store: 'categoryNotes', value: raw });
    await assert.rejects(runRecordSync(a, f.connection, f.transport, editingGuards), /保存が未確認/);
    assert.equal(await getPendingRecordPushBatch(a, f.connection), null);
    const before = await stored(a, 'appRecordMeta', 'state');
    const transport = { userId: f.connection.userId, cacheScope: 'prepared-pdf', exists: async () => false, upload: async () => {} };
    await read(a);
    assert.equal((await prepareRecordMaterialOutbox(a, transport, async () => {})).prepared, 1);
    assert.notEqual((await stored(a, 'appRecordMeta', 'state')).commitId, before.commitId);
    const prepared = (await records.readAppOutbox(a))[0];
    assert.equal(await stored(a, 'categoryNotes', id), raw);
    const batch = await freezeRecordPushBatch(a, f.connection);
    const nextId = 'quizMake:notes:s:__material_pdf_next';
    const nextRaw = raw.replace('"materialId":"pdf"', '"materialId":"next"');
    await auxiliary(a, 'indexedDbNotes', nextId, nextRaw, { store: 'categoryNotes', value: nextRaw });
    assert.deepEqual(await prepareRecordMaterialOutbox(a, { ...transport, exists: async () => assert.fail('resolve frozen receipt first') }, async () => {}), { prepared: 0, more: false });
    assert.deepEqual(await getPendingRecordPushBatch(a, f.connection), batch);
    assert.deepEqual((await records.readAppOutbox(a)).find(op => op.id === id), prepared);
    assert.equal(await stored(a, 'categoryNotes', nextId), nextRaw);
  } finally { a.close(); b.close(); }
});

test('an image saved during Push waits for Storage without trapping the following batch', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const local = await read(a); local.questions[0].explanation = 'Saved first';
    await records.saveAppRecords(a, local, timestamp);
    const blob = new Blob(['image added during upload'], { type: 'image/png' });
    const image = { id: 'during-push', questionId: 'q', name: 'a.png', type: blob.type, blob, addedAt: timestamp };
    const descriptor = await describeQuestionImage(image);
    const concurrent = { ...f.transport, async push(operations) {
      await auxiliary(a, 'questionImages', image.id, JSON.stringify(descriptor), { store: 'questionImageBlobs', value: image });
      return f.transport.push(operations);
    } };
    await assert.rejects(runRecordSync(a, f.connection, concurrent, editingGuards), /保存が未確認/);
    assert.equal(f.pushed.length, 1); assert.equal(await getPendingRecordPushBatch(a, f.connection), null);
    assert.equal((await records.readAppOutbox(a)).length, 1);
    assert.equal((await prepareQuestionImageOutbox(a, { userId: f.connection.userId, exists: async () => false, upload: async () => {} }, async () => {})).prepared, 1);
    assert.equal((await runRecordSync(a, f.connection, f.transport, editingGuards)).uploaded, 1);
    assert.equal((await records.readAppOutbox(a)).length, 0);
  } finally { a.close(); b.close(); }
});

test('equal image metadata cannot advance protected Pull past a missing live body', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const blob = new Blob(['recoverable remote body'], { type: 'image/png' });
    const image = { id: 'missing-body', questionId: 'q', name: 'a.png', type: blob.type, blob, addedAt: timestamp };
    const descriptor = remoteQuestionImageDescriptor(await describeQuestionImage(image), f.connection.userId);
    await auxiliary(b, 'questionImages', image.id, JSON.stringify(descriptor));
    const tx = b.transaction('appOutbox', 'readwrite'); const done = complete(tx);
    tx.objectStore('appOutbox').delete(records.appRecordKey('questionImages', image.id)); await done;
    await stageChanges(b, f.connection, [{ collection: 'questionImages', id: image.id, raw: JSON.stringify(descriptor) }]);
    const cursor = await stored(b, 'appRecordMeta', 'pullCursor');
    await prepareStagedQuestionImages(b, { userId: f.connection.userId, download: async () => blob }, async () => {});
    assert.equal((await applyStagedRecordPull(b, f.connection, [], { preserveLiveData: true })).deferred, true);
    assert.deepEqual(await stored(b, 'appRecordMeta', 'pullCursor'), cursor);
    assert.ok(await stored(b, 'appPullMedia', records.appRecordKey('questionImages', image.id)));
    assert.equal(await stored(b, 'questionImageBlobs', image.id), undefined);
    assert.equal((await applyStagedRecordPull(b, f.connection)).applied, true);
    assert.equal((await stored(b, 'questionImageBlobs', image.id)).blob.size, blob.size);
  } finally { a.close(); b.close(); }
});

test('failed incoming image verification preserves the live blob and cursor until a verified Home import', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const id = 'incoming-image', blob = new Blob(['remote image'], { type: 'image/png' });
    const descriptor = remoteQuestionImageDescriptor(await describeQuestionImage({ id, questionId: 'q', name: 'remote.png', type: blob.type, blob, addedAt: timestamp }), f.connection.userId);
    await stageChanges(b, f.connection, [{ collection: 'questionImages', id, raw: JSON.stringify(descriptor) }]);
    const cursor = await stored(b, 'appRecordMeta', 'pullCursor');
    const transport = { userId: f.connection.userId, download: async () => new Blob(['bad'], { type: 'image/png' }) };
    await assert.rejects(prepareStagedQuestionImages(b, transport, async () => {}), /画像の内容/);
    assert.equal(await stored(b, 'questionImageBlobs', id), undefined);
    assert.equal(await stored(b, 'appPullMedia', records.appRecordKey('questionImages', id)), undefined);
    assert.deepEqual(await stored(b, 'appRecordMeta', 'pullCursor'), cursor);
    await prepareStagedQuestionImages(b, { ...transport, download: async () => blob }, async () => {});
    assert.equal((await applyStagedRecordPull(b, f.connection, [], { preserveLiveData: true })).deferred, true);
    assert.equal(await stored(b, 'questionImageBlobs', id), undefined);
    assert.ok(await stored(b, 'appPullMedia', records.appRecordKey('questionImages', id)));
    assert.equal((await applyStagedRecordPull(b, f.connection)).applied, true);
    assert.equal((await stored(b, 'questionImageBlobs', id)).blob.size, blob.size);
  } finally { a.close(); b.close(); }
});

test('two devices transfer only one answer delta and merge edits to distinct records', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const answer = await read(a);
    Object.assign(answer.progress[0], { answeredCount: 1, correctCount: 1, lastSelectedIndex: 0, lastAnswerCorrect: true, lastAnsweredAt: timestamp });
    answer.answerLogs.push({ id: 'answer', questionId: 'q', setId: 's', folderId: 'f', selectedIndex: 0, selectedIndexes: [0], isCorrect: true, answeredAt: timestamp });
    await records.saveAppRecords(a, answer, timestamp);
    const sent = await runRecordSync(a, f.connection, f.transport, guards);
    assert.equal(sent.uploaded, 2);
    assert.deepEqual(f.pushed[0].map(op => op.collection).sort(), ['answerLogs','progress']);
    const received = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(received.downloaded, 2); assert.equal(received.uploaded, 0);
    assert.deepEqual(await read(b), answer);
    const left = await read(a); left.folders[0].name = 'Left';
    const right = await read(b); right.questions[0].question = 'Right';
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    assert.equal((await runRecordSync(a, f.connection, f.transport, guards)).status, 'done');
    assert.equal((await runRecordSync(b, f.connection, f.transport, guards)).status, 'done');
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(a), await read(b));
    assert.equal((await read(a)).folders[0].name, 'Left');
    assert.equal((await read(a)).questions[0].question, 'Right');
    console.log(`two-device answer: ${sent.uploaded} uploaded / ${received.downloaded} downloaded records, ${JSON.stringify(f.pushed[0]).length} request characters`);
  } finally { a.close(); b.close(); }
});

test('lost acknowledgement survives restart and a subsequent edit does not reuse the old operation', async () => {
  const f = await fixture(); let [a,b] = f.devices;
  try {
    const first = await read(a); first.folders[0].name = 'First';
    await records.saveAppRecords(a, first, timestamp);
    const unreliable = { ...f.transport, async push(ops) { await f.transport.push(ops); throw new Error('connection lost after commit'); } };
    await assert.rejects(runRecordSync(a, f.connection, unreliable, guards), /connection lost/);
    const frozen = await getPendingRecordPushBatch(a, f.connection);
    const later = await read(a); later.folders[0].name = 'Later';
    await records.saveAppRecords(a, later, timestamp);
    forceCloseDatabase(a); a = await database(f.factories[0]);
    const result = await runRecordSync(a, f.connection, f.transport, guards);
    assert.equal(result.status, 'done'); assert.equal(result.uploaded, 2);
    assert.deepEqual(f.pushed[1], frozen.operations);
    assert.notEqual(f.pushed[2][0].operationId, frozen.operations[0].operationId);
    await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal((await read(b)).folders[0].name, 'Later');
    assert.equal((await records.readAppOutbox(a)).length, 0);
  } finally { a.close(); b.close(); }
});

test('same-record offline changes retain both versions and protected work defers import', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const left = await read(a); left.questions[0].question = 'Remote';
    const right = await read(b); right.questions[0].question = 'Offline';
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const deferred = await runRecordSync(b, f.connection, f.transport, { ...guards, apply: async () => null });
    assert.equal(deferred.status, 'deferred'); assert.deepEqual(await read(b), right);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'conflict'); assert.equal(result.conflicts.length, 1);
    assert.equal(JSON.parse(result.conflicts[0].remote.raw).question, 'Remote');
    assert.equal(JSON.parse(result.conflicts[0].local.raw).question, 'Offline');
    assert.deepEqual(await read(b), right); assert.equal((await records.readAppOutbox(b)).length, 1);
  } finally { a.close(); b.close(); }
});

test('a frozen media batch never sends an unuploaded image or inline PDF body', async () => {
  const f = await fixture(); const [device, other] = f.devices;
  try {
    const unsafe = [
      { collection: 'questionImages', id: 'image', raw: JSON.stringify({ id: 'image', questionId: 'q', name: 'image.png',
        type: 'image/png', size: 1, sha256: '0'.repeat(64), addedAt: timestamp }) },
      { collection: 'indexedDbNotes', id: 'quizMake:notes:q:__material_pdf_pdf', raw: JSON.stringify({
        kind: 'quiz-material-file', version: 1, materialId: 'pdf', updatedAt: timestamp,
        dataUrl: 'data:application/pdf;base64,JVBERg==',
      }) },
    ];
    for (const item of unsafe) {
      const operation = { ...item, key: records.appRecordKey(item.collection, item.id), operationId: crypto.randomUUID(),
        position: 0, baseRevision: 0, localRevision: 1 };
      const batch = { id: crypto.randomUUID(), connection: f.connection, operations: [operation] };
      const tx = device.transaction('appRecordMeta', 'readwrite');
      const completion = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      tx.objectStore('appRecordMeta').put(batch, 'pushBatch');
      await completion;
      const transport = { ...f.transport, push() { assert.fail('unuploaded media must never reach the server'); } };
      await assert.rejects(runRecordSync(device, f.connection, transport, guards), /保存が未確認/);
      assert.deepEqual(await getPendingRecordPushBatch(device, f.connection), batch);
    }
  } finally { device.close(); other.close(); }
});

test('idle sync never opens the AppData records store and account changes fail before a request', async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const transaction = a.transaction.bind(a);
    a.transaction = (stores, ...args) => {
      assert.ok(!(typeof stores === 'string' ? [stores] : stores).includes('appRecords'), 'idle sync must not scan all records');
      return transaction(stores, ...args);
    };
    const result = await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(result, { status: 'done', uploaded: 0, downloaded: 0 });
    await assert.rejects(runRecordSync(a, f.connection, f.transport, { ...guards, assertCurrent: async () => { throw new Error('account changed'); } }), /account changed/);
    assert.equal(f.pushed.length, 0);
    for (const field of ['project', 'userId', 'syncId']) {
      await assert.rejects(runRecordSync(a, { ...f.connection, [field]: 'another' }, {
        pull: async () => assert.fail('must reject before reading a different remote'),
        push: async () => assert.fail('must reject before sending local data'),
      }, guards), /別の同期先/);
    }
  } finally { a.close(); b.close(); }
});

for (const choice of ['local', 'remote']) test(`explicit ${choice} conflict resolution is atomic, rejects stale choices and retains both versions`, async () => {
  const f = await fixture(); const [a,b] = f.devices;
  try {
    const left = await read(a); left.questions[0].question = 'Remote';
    const right = await read(b); right.questions[0].question = 'Offline';
    await records.saveAppRecords(a, left, timestamp); await records.saveAppRecords(b, right, timestamp);
    await runRecordSync(a, f.connection, f.transport, guards);
    const result = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(result.status, 'conflict');
    const conflict = result.conflicts[0];
    const decision = { key: conflict.key, operationId: conflict.operationId, remoteRevision: conflict.remote.revision, choice };
    await assert.rejects(applyStagedRecordPull(b, f.connection, [{ ...decision, operationId: 'stale' }]), /競合の内容が更新/);
    assert.deepEqual(await read(b), right);
    const applied = await applyStagedRecordPull(b, f.connection, [decision]);
    assert.equal(applied.applied, true);
    assert.equal((await read(b)).questions[0].question, choice === 'local' ? 'Offline' : 'Remote');
    const tx = b.transaction('appRecordConflicts', 'readonly');
    const retained = tx.objectStore('appRecordConflicts').getAll();
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
    const resolved = retained.result.filter(item => item.choice === choice);
    assert.equal(resolved.length, 1);
    assert.equal(JSON.parse(resolved[0].conflict.remote.raw).question, 'Remote');
    assert.equal(JSON.parse(resolved[0].conflict.local.raw).question, 'Offline');
    assert.ok(retained.result.some(item => item.reason === 'superseded'), 'the original active conflict is also archived');
    const sent = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(sent.uploaded, choice === 'local' ? 1 : 0);
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(a), await read(b));
  } finally { a.close(); b.close(); }
});
