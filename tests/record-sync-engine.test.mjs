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
const { getPendingRecordPushBatch } = await import('../src/utils/recordSyncOutbox.ts');
const { applyStagedRecordPull } = await import('../src/utils/recordSyncPull.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const pg = await createRecordProtocolDatabase();
after(() => pg.close());
const timestamp = '2026-09-28T01:00:00.000Z';
const guards = { assertCurrent: async () => {}, apply: operation => operation() };
let sequence = 100;
async function database(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open('records', 4);
    request.onupgradeneeded = () => records.upgradeAppRecordStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function fixture() {
  const connection = { project: 'test', userId: 'owner', syncId: String(sequence++).padStart(36, '0') };
  const initial = normalizeAppData({ version: 1,
    folders: [{ id: 'f', name: 'Folder', createdAt: timestamp, updatedAt: timestamp }],
    problemSets: [{ id: 's', folderId: 'f', title: 'Set', source: '', createdAt: timestamp, updatedAt: timestamp }],
    questions: [{ id: 'q', setId: 's', question: 'Question', choices: ['A','B','C','D'], answerIndex: 0, createdAt: timestamp, updatedAt: timestamp }],
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
    assert.equal((await runRecordSync(db, connection, transport, guards)).status, 'done');
    assert.equal((await records.readAppOutbox(db)).length, 0);
  }
  assert.equal(pushed.length, 0, 'bootstrap reconciles semantically equal JSON without echo uploads');
  return { connection, initial, devices, factories, transport, pushed };
}
const read = async db => (await records.readAppRecords(db)).data;

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
    assert.equal(retained.result.length, 1);
    assert.equal(retained.result[0].choice, choice);
    assert.equal(JSON.parse(retained.result[0].conflict.remote.raw).question, 'Remote');
    assert.equal(JSON.parse(retained.result[0].conflict.local.raw).question, 'Offline');
    const sent = await runRecordSync(b, f.connection, f.transport, guards);
    assert.equal(sent.uploaded, choice === 'local' ? 1 : 0);
    await runRecordSync(a, f.connection, f.transport, guards);
    assert.deepEqual(await read(a), await read(b));
  } finally { a.close(); b.close(); }
});
