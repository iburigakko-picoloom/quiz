import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
      && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
  },
});
process.on('exit', () => hook.deregister());
const records = await import('../src/utils/appRecordStorage.ts');
const syncOutbox = await import('../src/utils/recordSyncOutbox.ts');
const syncPull = await import('../src/utils/recordSyncPull.ts');
const metrics = await import('../src/utils/syncMetrics.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const timestamp = '2026-09-28T01:00:00.000Z';

async function database(factory = new IDBFactory()) {
  return new Promise((resolve, reject) => {
    const request = factory.open('records', 3);
    request.onupgradeneeded = () => records.upgradeAppRecordStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function get(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
  });
}
function data(count = 1) {
  const normalized = normalizeAppData({ version: 1,
    folders: [{ id: 'f', name: 'Folder', createdAt: timestamp, updatedAt: timestamp }],
    problemSets: [{ id: 's', folderId: 'f', title: 'Set', source: '', createdAt: timestamp, updatedAt: timestamp }],
    questions: Array.from({ length: count }, (_, i) => ({ id: `q${i}`, setId: 's', question: `Question ${i}`,
      choices: ['A', 'B', 'C', 'D'], answerIndex: 0, createdAt: timestamp, updatedAt: timestamp })), progress: [], answerLogs: [],
  });
  assert.equal(normalized.ok, true);
  return normalized.data;
}

test('record migration commits a complete manifest and outbox; one answer writes only progress and history', async () => {
  const db = await database();
  const initial = data(10000);
  await records.saveAppRecords(db, initial, timestamp);
  assert.deepEqual((await records.readAppRecords(db)).data, initial);
  const legacyState = await get(db, 'appRecordMeta', 'state');
  const previousOps = new Map((await records.readAppOutbox(db)).map(op => [op.key, op.operationId]));
  const next = structuredClone(initial);
  Object.assign(next.progress[0], { answeredCount: 1, correctCount: 1, lastSelectedIndex: 0, lastAnswerCorrect: true, lastAnsweredAt: timestamp });
  next.answerLogs.push({ id: 'answer-1', questionId: 'q0', setId: 's', folderId: 'f', selectedIndex: 0, selectedIndexes: [0], isCorrect: true, answeredAt: timestamp });
  metrics.resetSyncMetrics();
  const started = performance.now();
  await records.saveAppRecords(db, next, timestamp);
  const elapsed = performance.now() - started;
  assert.equal(metrics.getSyncMetrics().recordWrite.count, 2);
  const outbox = await records.readAppOutbox(db);
  const changed = outbox.filter(op => previousOps.get(op.key) !== op.operationId);
  assert.deepEqual(changed.map(op => op.collection).sort(), ['answerLogs', 'progress']);
  assert.equal((await get(db, 'appRecordMeta', 'state')).revision, legacyState.revision + 1);
  assert.deepEqual((await records.readAppRecords(db)).data, next);
  assert.deepEqual((await records.readPreviousAppRecords(db)).data, initial);
  console.log(`record benchmark: 10000 questions, one answer ${elapsed.toFixed(2)} ms, 2 record writes, ${metrics.getSyncMetrics().recordWrite.bytes} characters`);
  metrics.resetSyncMetrics();
  await records.saveAppRecords(db, next, timestamp);
  assert.equal(metrics.getSyncMetrics().recordWrite, undefined);
  db.close();
});

test('deletions retain tombstones, coalesce pending edits and restore the exact prior commit', async () => {
  const db = await database();
  const first = data(2);
  await records.saveAppRecords(db, first, timestamp);
  const next = structuredClone(first);
  next.questions.pop(); next.progress.pop();
  await records.saveAppRecords(db, next, timestamp);
  const deleted = await get(db, 'appRecords', records.appRecordKey('questions', 'q1'));
  assert.equal(deleted.raw, null);
  assert.equal((await records.readAppOutbox(db)).find(op => op.key === deleted.key).raw, null);
  assert.deepEqual((await records.readPreviousAppRecords(db)).data, first);
  const edited = structuredClone(next); edited.questions[0].question = 'Edited';
  await records.saveAppRecords(db, edited, timestamp);
  assert.deepEqual((await records.readPreviousAppRecords(db)).data, next);
  assert.equal((await records.readAppOutbox(db)).filter(op => op.key === records.appRecordKey('questions', 'q0')).length, 1);
  db.close();
});

test('aborted migration/save cannot commit a manifest or partial outbox and can be retried', async () => {
  const db = await database();
  const realTransaction = db.transaction.bind(db);
  let abortWrites = true;
  db.transaction = (...args) => {
    const tx = realTransaction(...args);
    if (abortWrites && args[1] === 'readwrite') {
      // Abort after all writes were queued but before the transaction commits.
      const request = tx.objectStore('appRecordMeta').get('state');
      request.onsuccess = () => { queueMicrotask(() => tx.abort()); };
    }
    return tx;
  };
  await assert.rejects(records.saveAppRecords(db, data(), timestamp), /abort/i);
  assert.equal(await get(db, 'appRecordMeta', 'state'), undefined);
  assert.deepEqual(await records.readAppOutbox(db), []);
  assert.equal(await records.readAppRecords(db), null);
  abortWrites = false;
  await records.saveAppRecords(db, data(), timestamp);
  const before = await get(db, 'appRecordMeta', 'state');
  const beforeOps = await records.readAppOutbox(db);
  abortWrites = true;
  const next = data(); next.folders[0].name = 'Interrupted';
  await assert.rejects(records.saveAppRecords(db, next, timestamp), /abort/i);
  assert.deepEqual(await get(db, 'appRecordMeta', 'state'), before);
  assert.deepEqual(await records.readAppOutbox(db), beforeOps);
  assert.deepEqual((await records.readAppRecords(db)).data, data());
  db.close();
});

test('missing records fail closed instead of silently producing an empty or partial database', async () => {
  const db = await database();
  await records.saveAppRecords(db, data(), timestamp);
  await new Promise(resolve => {
    const tx = db.transaction('appRecords', 'readwrite');
    tx.objectStore('appRecords').delete(records.appRecordKey('questions', 'q0'));
    tx.oncomplete = resolve;
  });
  await assert.rejects(records.readAppRecords(db), /失われ/);
  db.close();
});

test('simultaneous writers use commit CAS and preserve the winning outbox', async () => {
  const factory = new IDBFactory();
  const db1 = await database(factory);
  const db2 = await database(factory);
  await records.saveAppRecords(db1, data(), timestamp);
  await records.readAppRecords(db2);
  const first = data(); first.folders[0].name = 'First';
  const second = data(); second.folders[0].name = 'Second';
  const results = await Promise.allSettled([
    records.saveAppRecords(db1, first, timestamp), records.saveAppRecords(db2, second, timestamp),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /別のタブ/);
  const current = (await records.readAppRecords(db1)).data;
  const op = (await records.readAppOutbox(db1)).find(op => op.collection === 'folders');
  assert.equal(JSON.parse(op.raw).name, current.folders[0].name);
  db1.close(); db2.close();
});

test('forced connection closure preserves the last committed revision after reopen', async () => {
  const factory = new IDBFactory();
  const db = await database(factory);
  await records.saveAppRecords(db, data(), timestamp);
  const state = await get(db, 'appRecordMeta', 'state');
  const outbox = await records.readAppOutbox(db);
  forceCloseDatabase(db);
  const reopened = await database(factory);
  assert.deepEqual(await get(reopened, 'appRecordMeta', 'state'), state);
  assert.deepEqual(await records.readAppOutbox(reopened), outbox);
  assert.deepEqual((await records.readAppRecords(reopened)).data, data());
  reopened.close();
});

test('loss of record stores cannot make an old migration snapshot authoritative again', async () => {
  const db = await database();
  await records.saveAppRecords(db, data(), timestamp);
  await new Promise(resolve => {
    const tx = db.transaction(['appRecords', 'appRecordMeta'], 'readwrite');
    tx.objectStore('appRecords').clear(); tx.objectStore('appRecordMeta').clear();
    tx.oncomplete = resolve;
  });
  await assert.rejects(records.readAppRecords(db), /移行状態/);
  db.close();
});

test('response loss/restart reuses frozen operations; edits during upload survive acknowledgement', async () => {
  const factory = new IDBFactory();
  const db = await database(factory);
  await records.saveAppRecords(db, data(), timestamp);
  const connection = { project: 'https://project.example', userId: 'user', syncId: '1'.repeat(36) };
  const batch = await syncOutbox.freezeRecordPushBatch(db, connection);
  assert.ok(batch.operations.length > 0);
  const next = data(); next.questions[0].question = 'Answered while offline';
  await records.saveAppRecords(db, next, timestamp);
  assert.deepEqual(await syncOutbox.freezeRecordPushBatch(db, connection), batch);
  await assert.rejects(syncOutbox.freezeRecordPushBatch(db, { ...connection, userId: 'another' }), /別の同期先/);
  forceCloseDatabase(db);
  const reopened = await database(factory);
  assert.deepEqual(await syncOutbox.freezeRecordPushBatch(reopened, connection), batch);
  const response = { code: 'ok', revision: 1, ack: batch.operations.map(op => ({ operationId: op.operationId, key: op.key, revision: 1 })) };
  await assert.rejects(syncOutbox.acknowledgeRecordPushBatch(reopened, batch, { ...response, ack: [] }), /応答が不正/);
  assert.deepEqual(await syncOutbox.freezeRecordPushBatch(reopened, connection), batch);
  await syncOutbox.acknowledgeRecordPushBatch(reopened, batch, response);
  const pending = await records.readAppOutbox(reopened);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].collection, 'questions');
  assert.equal(pending[0].baseRevision, 1);
  assert.equal(pending[0].baseContent.raw, batch.operations.find(operation => operation.key === pending[0].key).raw);
  assert.equal(JSON.parse(pending[0].raw).question, 'Answered while offline');
  const secondBatch = await syncOutbox.freezeRecordPushBatch(reopened, connection);
  assert.notEqual(secondBatch.id, batch.id);
  assert.equal(secondBatch.operations.length, 1);
  assert.deepEqual((await records.readAppRecords(reopened)).data, next);
  assert.equal(await get(reopened, 'appRecordMeta', 'pullCursor'), undefined, 'push must never skip unseen remote changes');
  reopened.close();
});

test('quota failure after queueing a record write atomically rolls back its outbox and revision', async () => {
  const db = await database();
  const initial = data();
  await records.saveAppRecords(db, initial, timestamp);
  const before = await get(db, 'appRecordMeta', 'state');
  const beforeOps = await records.readAppOutbox(db);
  const realTransaction = db.transaction.bind(db);
  db.transaction = (...args) => {
    const tx = realTransaction(...args);
    if (args[1] === 'readwrite') {
      const realStore = tx.objectStore.bind(tx);
      tx.objectStore = name => {
        const store = realStore(name);
        if (name === 'appOutbox') store.put = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
        return store;
      };
    }
    return tx;
  };
  const next = data(); next.folders[0].name = 'Cannot commit';
  await assert.rejects(records.saveAppRecords(db, next, timestamp), { name: 'QuotaExceededError' });
  db.transaction = realTransaction;
  assert.deepEqual(await get(db, 'appRecordMeta', 'state'), before);
  assert.deepEqual(await records.readAppOutbox(db), beforeOps);
  assert.deepEqual((await records.readAppRecords(db)).data, initial);
  db.close();
});

const connection = { project: 'https://project.example', userId: 'user', syncId: '1'.repeat(36) };
const change = (collection, id, raw, revision, position = 0) => ({ collection,id,raw:raw === null ? null : JSON.stringify(raw),key:records.appRecordKey(collection,id),revision,position });
const page = (revision, changes, head = revision) => ({ code:'ok',cursor:revision,head,hasMore:revision<head,batches:[{revision,changes}] });
async function initializePull(db, initial) {
  await records.saveAppRecords(db,initial,timestamp);
  const changes = records.APP_COLLECTIONS.flatMap(collection => initial[collection].map((row,position) => change(collection,collection==='progress'?row.questionId:row.id,row,1,position)));
  await syncPull.stageRecordPullPage(db,connection,0,page(1,changes));
  assert.equal((await syncPull.applyStagedRecordPull(db,connection)).applied,true);
  assert.equal((await records.readAppOutbox(db)).length,0);
}

test('Pull stages pages without changing live data; restart resumes and commits only changed records', async () => {
  const factory = new IDBFactory();
  const db = await database(factory);
  const initial = data();
  await initializePull(db,initial);
  const folder = { ...initial.folders[0],name:'remote folder' };
  await syncPull.stageRecordPullPage(db,connection,1,page(2,[change('folders','f',folder,2)],3));
  assert.deepEqual((await records.readAppRecords(db)).data,initial);
  await assert.rejects(syncPull.applyStagedRecordPull(db,connection),/全ページ/);
  forceCloseDatabase(db);
  const reopened = await database(factory);
  assert.equal(await syncPull.getRecordPullCursor(reopened,connection),2);
  const question = { ...initial.questions[0],question:'remote question' };
  await syncPull.stageRecordPullPage(reopened,connection,2,page(3,[change('questions','q0',question,3)]));
  metrics.resetSyncMetrics();
  const result = await syncPull.applyStagedRecordPull(reopened,connection);
  assert.equal(result.applied,true); assert.equal(result.cursor,3); assert.equal(result.changed,2);
  assert.equal(metrics.getSyncMetrics().pullRecordWrite.count,2);
  assert.deepEqual(result.data,{ ...initial,folders:[folder],questions:[question] });
  assert.deepEqual((await records.readPreviousAppRecords(reopened)).data,initial);
  assert.equal((await records.readAppOutbox(reopened)).length,0,'remote import must never echo as new local operations');
  assert.equal(await get(reopened,'appRecordMeta','pullStage'),undefined);
  reopened.close();
});

test('record conflicts persist both versions without LWW or advancing the accepted cursor', async () => {
  const db = await database();
  const initial = data();
  await initializePull(db,initial);
  const local = structuredClone(initial); local.questions[0].question='local';
  await records.saveAppRecords(db,local,timestamp);
  const remote = { ...initial.questions[0],question:'remote',updatedAt:'1900-01-01T00:00:00.000Z' };
  await syncPull.stageRecordPullPage(db,connection,1,page(2,[change('questions','q0',remote,2)]));
  const result = await syncPull.applyStagedRecordPull(db,connection);
  assert.equal(result.applied,false); assert.equal(result.conflicts.length,1);
  assert.equal(JSON.parse(result.conflicts[0].local.raw).question,'local');
  assert.equal(JSON.parse(result.conflicts[0].remote.raw).question,'remote');
  assert.deepEqual((await records.readAppRecords(db)).data,local);
  assert.equal((await get(db,'appRecordMeta','pullCursor')).cursor,1);
  assert.equal((await get(db,'appRecordConflicts')).length,1);
  assert.equal((await records.readAppOutbox(db)).length,1);
  db.close();
});

test('Pull rejects cursor gaps, mismatched IDs and orphaned imports without changing data', async () => {
  const db = await database(); const initial = data();
  await initializePull(db,initial);
  await assert.rejects(syncPull.stageRecordPullPage(db,connection,1,page(3,[change('folders','f',initial.folders[0],3)])),/連続/);
  await assert.rejects(syncPull.stageRecordPullPage(db,connection,1,page(2,[change('folders','other',initial.folders[0],2)])),/一致/);
  await syncPull.stageRecordPullPage(db,connection,1,page(2,[change('problemSets','s',null,2)]));
  await assert.rejects(syncPull.applyStagedRecordPull(db,connection),/存在しない/);
  assert.deepEqual((await records.readAppRecords(db)).data,initial);
  assert.equal((await get(db,'appRecordMeta','pullCursor')).cursor,1);
  db.close();
});

test('transaction abort rolls back remote records and Pull cursor together', async () => {
  const db = await database(); const initial = data();
  await initializePull(db,initial);
  await syncPull.stageRecordPullPage(db,connection,1,page(2,[change('folders','f',{ ...initial.folders[0],name:'remote' },2)]));
  const real = db.transaction.bind(db);
  db.transaction=(...args)=>{
    const tx=real(...args);
    if(args[1]==='readwrite') {
      const req=tx.objectStore('appRecordMeta').get('state'); req.onsuccess=()=>queueMicrotask(()=>tx.abort());
    }
    return tx;
  };
  await assert.rejects(syncPull.applyStagedRecordPull(db,connection));
  db.transaction=real;
  assert.deepEqual((await records.readAppRecords(db)).data,initial);
  assert.equal((await get(db,'appRecordMeta','pullCursor')).cursor,1);
  assert.equal((await get(db,'appPullStage')).length,1,'failed commit retains staged response for retry');
  assert.equal((await syncPull.applyStagedRecordPull(db,connection)).applied,true);
  db.close();
});

test('large offline queues freeze bounded cursor batches without reading the entire outbox', async () => {
  const db = await database();
  try {
    await records.saveAppRecords(db, data(1000), timestamp);
    const real = db.transaction.bind(db);
    db.transaction = (...args) => {
      const tx = real(...args);
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = name => {
        const store = objectStore(name);
        if (name === 'appOutbox') store.getAll = () => assert.fail('freezing must not read all pending records');
        return store;
      };
      return tx;
    };
    const batch = await syncOutbox.freezeRecordPushBatch(db, connection);
    assert.equal(batch.operations.length, 500);
    assert.deepEqual(await syncOutbox.freezeRecordPushBatch(db, connection), batch);
    db.transaction = real;
    assert.equal((await records.readAppOutbox(db)).length, 2002);
  } finally { db.close(); }
});

test('one-answer Pull reuses the verified snapshot and reads only matching Outbox keys', async () => {
  const db = await database();
  try {
    const initial = data(1000);
    await initializePull(db, initial);
    const progress = { ...initial.progress[0], answeredCount: 1, correctCount: 1, lastAnsweredAt: timestamp };
    const log = { id: 'remote-answer', questionId: 'q0', setId: 's', folderId: 'f', selectedIndex: 0,
      selectedIndexes: [0], isCorrect: true, answeredAt: timestamp };
    await syncPull.stageRecordPullPage(db, connection, 1, page(2, [
      change('progress', 'q0', progress, 2), change('answerLogs', 'remote-answer', log, 2),
    ]));
    const real = db.transaction.bind(db);
    db.transaction = (...args) => {
      const names = typeof args[0] === 'string' ? [args[0]] : args[0];
      assert.ok(!names.includes('appPullMedia') && !names.includes('questionImageBlobs'),
        'an answer-only Pull must not open image stores');
      const tx = real(...args);
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = name => {
        const store = objectStore(name);
        if (['appRecords', 'appOutbox', 'appPullMedia', 'questionImageBlobs'].includes(name)) {
          store.getAll = () => assert.fail(`${name} must not be read in full for one answer`);
        }
        return store;
      };
      return tx;
    };
    metrics.resetSyncMetrics();
    const applied = await syncPull.applyStagedRecordPull(db, connection);
    assert.equal(applied.applied, true);
    assert.equal(applied.changed, 2);
    assert.equal(applied.data.questions.length, 1000);
    assert.equal(metrics.getSyncMetrics().recordSnapshotReused.count, 1);
    assert.equal(metrics.getSyncMetrics().pullRecordWrite.count, 2);
    db.transaction = real;
    assert.equal((await get(db, 'appRecordMeta', 'pullCursor')).cursor, 2);
  } finally { db.close(); }
});

test('a changed commit ID discards the cached snapshot before Pull', async () => {
  const db = await database();
  try {
    const initial = data();
    await initializePull(db, initial);
    const state = await get(db, 'appRecordMeta', 'state');
    const tx = db.transaction('appRecordMeta', 'readwrite');
    const completed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    tx.objectStore('appRecordMeta').put({ ...state, commitId: crypto.randomUUID() }, 'state');
    await completed;
    await syncPull.stageRecordPullPage(db, connection, 1, page(2, [
      change('folders', 'f', { ...initial.folders[0], name: 'Updated' }, 2),
    ]));
    metrics.resetSyncMetrics();
    const applied = await syncPull.applyStagedRecordPull(db, connection);
    assert.equal(applied.applied, true);
    assert.equal(applied.data.folders[0].name, 'Updated');
    assert.equal(metrics.getSyncMetrics().recordSnapshotReused, undefined);
  } finally { db.close(); }
});

test('answer-only Pull validates changed rows and preserves the accepted cursor on corruption', async () => {
  const db = await database();
  try {
    const initial = data();
    await initializePull(db, initial);
    const invalid = { id: 'bad-log', questionId: 'q0', setId: 's', folderId: 'f',
      selectedIndex: 9, selectedIndexes: [9], isCorrect: false, answeredAt: timestamp };
    await syncPull.stageRecordPullPage(db, connection, 1, page(2, [change('answerLogs', 'bad-log', invalid, 2)]));
    await assert.rejects(syncPull.applyStagedRecordPull(db, connection), /回答履歴の参照/);
    assert.equal((await get(db, 'appRecordMeta', 'pullCursor')).cursor, 1);
    assert.deepEqual((await records.readAppRecords(db)).data, initial);
  } finally { db.close(); }
});

test('answer-only Pull applies log tombstones and resets removed progress', async () => {
  const db = await database();
  try {
    const initial = data();
    const log = { id: 'answer', questionId: 'q0', setId: 's', folderId: 'f', selectedIndex: 0,
      selectedIndexes: [0], isCorrect: true, answeredAt: timestamp };
    initial.answerLogs = [log];
    initial.progress[0] = { ...initial.progress[0], answeredCount: 1, correctCount: 1, lastAnsweredAt: timestamp };
    await initializePull(db, initial);
    await syncPull.stageRecordPullPage(db, connection, 1, page(2, [
      change('answerLogs', 'answer', null, 2), change('progress', 'q0', null, 2),
    ]));
    const applied = await syncPull.applyStagedRecordPull(db, connection);
    assert.equal(applied.applied, true);
    assert.equal(applied.data.answerLogs.length, 0);
    assert.equal(applied.data.progress[0].answeredCount, 0);
    assert.deepEqual((await records.readAppRecords(db)).data, applied.data);
    await syncPull.stageRecordPullPage(db, connection, 2, page(3, [change('answerLogs', 'answer', null, 3)]));
    const repeated = await syncPull.applyStagedRecordPull(db, connection);
    assert.equal(repeated.applied, true);
    assert.deepEqual(repeated.data, applied.data);
  } finally { db.close(); }
});
