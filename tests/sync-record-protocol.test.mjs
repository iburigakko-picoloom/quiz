import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRecordProtocolDatabase } from './helpers/record-protocol-db.mjs';

const pg = await createRecordProtocolDatabase();
after(() => pg.close());
const timestamp = '2026-09-28T01:00:00Z';
const syncId = '1'.repeat(36);
const otherId = '2'.repeat(36);
const emptyApp = { version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[] };
const snapshot = app => ({ version:1,updatedAt:timestamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(app)},indexedDbNotes:{} });
await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values ($1,$3,private.quiz_sync_actor_hash(),$4),($2,$3,private.quiz_sync_actor_hash(),$4)', [syncId, otherId, timestamp,JSON.stringify(snapshot(emptyApp))]);
async function call(name, args, types) {
  const placeholders = args.map((_, i) => `$${i + 1}::${types[i]}`).join(',');
  const { rows } = await pg.query(`select public.${name}(${placeholders}) as result`, args);
  return rows[0].result;
}
const open = (id = syncId) => call('quiz_sync_v2_open', [id, timestamp], ['text','timestamptz']);
const push = (ops, id = syncId) => call('quiz_sync_v2_push', [id, JSON.stringify(ops)], ['text','jsonb']);
const pull = (cursor, limit = 10, id = syncId) => call('quiz_sync_v2_pull', [id,cursor,limit], ['text','bigint','integer']);
const operation = (id, raw, baseRevision = 0, collection = 'folders') => ({ operationId: randomUUID(), key: JSON.stringify([collection,id]), collection, id, raw, position: 0, baseRevision });

test('SQL protocol scopes records by account and returns commit-bounded deltas with idempotent acknowledgements', async () => {
  assert.deepEqual(await open(), { code:'ok', revision:0 });
  const initial = [operation('a','{"id":"a","name":"A"}'), operation('b','{"id":"b","name":"B"}')];
  const first = await push(initial);
  assert.equal(first.code,'ok'); assert.equal(first.revision,1); assert.equal(first.ack.length,2);
  assert.ok(JSON.stringify(first).length < 500, 'success response never echoes the snapshot');
  assert.deepEqual(await push(initial), first, 'lost success response can retry exact operation IDs');
  const page = await pull(0,1);
  assert.equal(page.cursor,1); assert.equal(page.batches.length,1); assert.equal(page.batches[0].changes.length,2);
  assert.deepEqual((await pull(1)).batches,[]);
  await pg.query("select set_config('test.actor','intruder',false)");
  await assert.rejects(pull(0), /sync_not_found/);
  await assert.rejects(push([operation('x','{}')]), /sync_not_found/);
  await pg.query("select set_config('test.actor','owner',false)");
});

test('record CAS rejects only stale records and an atomic batch cannot partially overwrite data', async () => {
  const a = operation('a','{"id":"a","name":"changed"}',1);
  assert.equal((await push([a])).code,'ok');
  const result = await push([operation('b','{"id":"b","name":"must not commit"}',1), operation('a','{"id":"a","name":"stale"}',1)]);
  assert.equal(result.code,'conflict');
  const row = await pg.query('select raw from private.quiz_sync_records where sync_id=$1 and record_id=$2',[syncId,'b']);
  assert.equal(row.rows[0].raw,'{"id":"b","name":"B"}');
  assert.equal((await push([operation('b','{"id":"b","name":"independent"}',1)])).code,'ok');
  const alteredRetry = { ...a, raw:'{"id":"a","name":"reused UUID"}' };
  assert.equal((await push([alteredRetry])).code,'operation_reused');
});

test('tombstones prevent offline resurrection and pull pagination never loses intermediate commits', async () => {
  const deleted = await push([operation('a',null,2)]);
  assert.equal(deleted.code,'ok');
  assert.equal((await push([operation('a','{"id":"a"}',2)])).code,'conflict');
  const first = await pull(1,1); assert.equal(first.cursor,2); assert.equal(first.hasMore,true);
  const second = await pull(first.cursor,1); assert.equal(second.cursor,3);
  const last = await pull(second.cursor,1); assert.equal(last.cursor,deleted.revision);
  assert.equal(last.batches[0].changes[0].raw,null);
  assert.equal((await pull(999)).code,'invalid_cursor');
});

test('uninitialized, malformed, oversized and stale snapshot requests fail without writes', async () => {
  assert.equal((await push([operation('x','{}')],otherId)).code,'not_initialized');
  assert.equal((await push([])).code,'invalid');
  const op = operation('x','{}');
  assert.equal((await push([op,op])).code,'invalid');
  assert.equal((await push([{ ...op, raw:'x'.repeat(1048577) }])).code,'invalid');
  for (const raw of ['not JSON', 'null', '[]', '{}', '{"id":"wrong"}']) {
    assert.equal((await push([operation('x',raw)])).code,'invalid');
  }
  assert.equal((await push([operation('quiz-make-app-data-v1','{}',0,'localStorage')])).code,'invalid');
  assert.equal((await pg.query('select count(*)::integer as count from private.quiz_sync_records where sync_id=$1 and record_id=$2',[syncId,'x'])).rows[0].count,0);
  await pg.query('update public.quiz_sync_data set updated_at=updated_at+interval \'1 second\' where sync_id=$1',[syncId]);
  assert.equal((await push([op])).code,'snapshot_changed');
  assert.equal((await pull(0)).code,'snapshot_changed');
});

test('pre-AppData Snapshot remains on the legacy path without creating a V2 head', async () => {
  const id = '9'.repeat(36);
  await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)',
    [id, timestamp, JSON.stringify({ version: 1, updatedAt: timestamp, localStorage: {}, indexedDbNotes: {} })]);
  assert.deepEqual(await open(id), { code: 'legacy_snapshot' });
  const { rows } = await pg.query('select count(*)::integer as count from private.quiz_sync_heads where sync_id=$1', [id]);
  assert.equal(rows[0].count, 0);
});

test('anonymous and direct table access remain forbidden', async () => {
  await pg.exec('set role anon');
  await assert.rejects(open(), /permission denied/);
  await pg.exec('reset role; set role authenticated');
  await assert.rejects(pg.query('select * from private.quiz_sync_records'), /permission denied/);
  await pg.exec('reset role');
});

test('bootstrap and legacy Snapshot writes share record history; legacy reads see latest deltas', async () => {
  const id = '3'.repeat(36);
  const initial = { ...emptyApp, folders:[{id:'folder, with spaces',name:'original'}] };
  const payload = snapshot(initial);
  payload.indexedDbNotes['quizMake:notes:example'] = '{"body":"note"}';
  await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)', [id,timestamp,JSON.stringify(payload)]);
  const opened = await open(id);
  assert.equal(opened.revision,1);
  const page = await pull(0,1,id);
  assert.equal(page.batches[0].changes.length,2);
  const folder = page.batches[0].changes.find(row => row.collection==='folders');
  assert.equal(folder.key,JSON.stringify(['folders','folder, with spaces']));
  const op = operation(folder.id,JSON.stringify({ id:folder.id,name:'delta' }),folder.revision);
  const pushed = await push([op],id);
  assert.equal(pushed.code,'ok');
  const read = await pg.query('select * from public.quiz_sync_read($1)',[id]);
  assert.equal(JSON.parse(read.rows[0].data.localStorage['quiz-make-app-data-v1']).folders[0].name,'delta');
  assert.notEqual(read.rows[0].updated_at.toISOString(),new Date(timestamp).toISOString());
  const oldSnapshot = await pg.query('select data from public.quiz_sync_data where sync_id=$1',[id]);
  assert.deepEqual(oldSnapshot.rows[0].data,payload,'record push preserves original recovery JSON');
  await pg.query('update public.quiz_sync_data set data=$2,updated_at=clock_timestamp() where sync_id=$1',[id,JSON.stringify(snapshot(emptyApp))]);
  const deletion = await pull(pushed.revision,10,id);
  assert.equal(deletion.batches.length,1);
  assert.ok(deletion.batches[0].changes.every(row => row.raw===null));
  assert.equal((await push([operation(folder.id,op.raw,pushed.revision)],id)).code,'conflict');
  const retry = await push([op],id);
  assert.deepEqual(retry.ack,pushed.ack,'Snapshot restore must not erase lost-response operation receipts');
  assert.equal((await pull(deletion.cursor,10,id)).batches.length,0);
});

test('question image metadata survives Snapshot compatibility reads and opaque lookalike keys remain intact', async () => {
  const id='4'.repeat(36);
  const payload=snapshot(emptyApp);
  payload.localStorage['quizMake:image:img'] = JSON.stringify({id:'img',questionId:'q',path:'owner/hash.png'});
  payload.localStorage['quizMake:image:legacy'] = 'opaque old value';
  await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$2,private.quiz_sync_actor_hash(),$3)',[id,timestamp,JSON.stringify(payload)]);
  assert.equal((await open(id)).code,'ok');
  const page=await pull(0,10,id);
  assert.equal(page.batches[0].changes.some(row=>row.collection==='questionImages'&&row.id==='img'),true);
  const read=await pg.query('select data from public.quiz_sync_read($1)',[id]);
  assert.equal(read.rows[0].data.localStorage['quizMake:image:img'],payload.localStorage['quizMake:image:img']);
  assert.equal(read.rows[0].data.localStorage['quizMake:image:legacy'],'opaque old value');
});
