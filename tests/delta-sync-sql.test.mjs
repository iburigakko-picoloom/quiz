import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createRecordProtocolDatabase } from './helpers/record-protocol-db.mjs';
const pg = await createRecordProtocolDatabase(); after(() => pg.close());
await pg.exec('create role service_role');
await pg.exec(await readFile(new URL('../supabase/migrations/20261005154212_quiz_whole_commit.sql', import.meta.url), 'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261007105000_quiz_whole_finish_typed_rows.sql', import.meta.url), 'utf8'));
await pg.exec("create schema auth; create function auth.uid() returns uuid language sql as $$select case when coalesce(current_setting('test.actor',true),'')='' then null else md5(current_setting('test.actor'))::uuid end$$; grant usage on schema auth to authenticated;");
for(const name of ['20261007165623_quiz_answer_sync_optimization','20261012003104_sync_timeout_bounded_work','20261012021630_sync_finish_stream_changes','20261015024034_sync_concurrent_staging_and_finish_budget'])await pg.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261015232702_quiz_delta_sync.sql', import.meta.url), 'utf8'));
const functionPermissions=async()=> (await pg.query("select prosecdef,proconfig,proacl from pg_proc where oid='private.quiz_delta_sync(text,text,jsonb)'::regprocedure")).rows;
const beforeResumePermissions=await functionPermissions();
const resumeMigration=await readFile(new URL('../supabase/migrations/20261016094737_quiz_delta_resumable_finish.sql', import.meta.url), 'utf8');
await pg.exec(resumeMigration);
test('the exact resumable migration preserves function security and execution permissions',async()=>{
  assert.deepEqual(await functionPermissions(),beforeResumePermissions);
  console.log('VERIFIED_RESUME_MIGRATION_SHA256',createHash('sha256').update(resumeMigration).digest('hex'));
});
const stamp = '2026-10-16T00:00:00Z';
async function call(sync, action, request = {}) { return (await pg.query('select public.quiz_delta_sync($1,$2,$3) result', [sync, action, JSON.stringify(request)])).rows[0].result; }
async function create() {
  const sync = randomUUID().replaceAll('-', '') + '0000';
  const data = { version: 1, localStorage: { 'quiz-make-app-data-v1': JSON.stringify({ version: 1, folders: [{ id: 'f', name: 'Original' }], problemSets: [], questions: [], progress: [], answerLogs: [] }) } };
  await pg.query('insert into public.quiz_sync_data(sync_id,data,updated_at,creator_hash) values($1,$2,$3,private.quiz_sync_actor_hash())', [sync, JSON.stringify(data), stamp]);
  await pg.query('select public.quiz_sync_v2_open($1,$2)', [sync, stamp]); return sync;
}
const row = name => ({ key: '["folders","f"]', collection: 'folders', id: 'f', raw: JSON.stringify({ id: 'f', name }), position: 0, localRevision: 1, baseRevision: 1, operationId: randomUUID() });
function request(rows, sequence = 1) { const payload = JSON.stringify(rows); return { operationId: randomUUID(), deviceId: randomUUID(), sequence, parts: 1, part: 0, payload, digest: createHash('sha256').update(payload).digest('hex') }; }
test('activation keeps exact legacy rows and snapshot; old writer is fenced', async () => {
  const sync = await create();
  const before = (await pg.query('select record_key,raw,position,revision from private.quiz_sync_records where sync_id=$1', [sync])).rows;
  const status = await call(sync, 'status'); assert.equal(status.enabled, false);
  assert.equal((await call(sync, 'enable', { revision: status.revision - 1 })).code, 'conflict');
  assert.equal((await call(sync, 'enable', { revision: status.revision })).code, 'ok');
  assert.deepEqual((await pg.query('select record_key,raw,position,revision from private.quiz_sync_records where sync_id=$1', [sync])).rows, before);
  await assert.rejects(pg.query('update private.quiz_sync_records set raw=null where sync_id=$1', [sync]), /update_required/);
  assert.equal((await pg.query('select public.quiz_whole_open($1,$2) r',[sync,1])).rows[0].r.code,'update_required');
  assert.equal((await pg.query('select public.quiz_whole_finish($1,$2) r',[sync,randomUUID()])).rows[0].r.code,'update_required');
  assert.equal((await pg.query('select public.quiz_whole_commit($1,$2,1,1,$3,$4,$5,$6) r',[sync,randomUUID(),'0'.repeat(64),'old-device',randomUUID(),'[]'])).rows[0].r.code,'update_required');
  assert.equal((await pg.query('select public.quiz_sync_v2_open($1,$2) r',[sync,stamp])).rows[0].r.code,'update_required');
  assert.equal((await call(sync, 'checkpoint')).rows.length, 1);
});
test('server commit order wins and a lost-response retry never wins again', async () => {
  const sync = await create(); await call(sync, 'enable', { revision: 1 });
  const a = request([row('A')]), b = request([row('B')]);
  const first = await call(sync, 'push', a); assert.equal(first.state, 'committed');
  const second = await call(sync, 'push', b); assert.equal(second.revision, first.revision + 1);
  assert.deepEqual(await call(sync, 'push', a), first);
  assert.equal((await call(sync, 'receipt', { operationId: a.operationId })).revision, first.revision);
  const current = (await pg.query('select raw from private.quiz_sync_records where sync_id=$1', [sync])).rows[0].raw;
  assert.equal(JSON.parse(current).name, 'B');
  assert.equal((await call(sync, 'push', { ...a, digest: '0'.repeat(64) })).code, 'operation_reused');
  await pg.exec("select set_config('test.actor','other',false)"); await assert.rejects(call(sync, 'status'), /sync_not_found/);
  await pg.exec("select set_config('test.actor','owner',false)");
});
test('explicit stream removal cascades all delta state without weakening the writer fence',async()=>{
  const sync=await create();await call(sync,'enable',{revision:1});await call(sync,'push',request([row('edited')]));
  await assert.rejects(pg.query('delete from private.quiz_sync_records where sync_id=$1',[sync]),/update_required/);
  await pg.query('delete from public.quiz_sync_data where sync_id=$1',[sync]);
  for(const table of ['quiz_sync_heads','quiz_sync_records','quiz_delta_history','quiz_delta_log','quiz_delta_receipts','quiz_delta_parts','quiz_delta_rescues'])assert.equal((await pg.query(`select count(*)::integer n from private.${table} where sync_id=$1`,[sync])).rows[0].n,0);
});
test('a split operation is invisible until every exact part arrives', async () => {
  const sync = await create(); await call(sync, 'enable', { revision: 1 });
  const a = request([row('中'.repeat(90000))]); const first = { ...a, parts: 2, payload: a.payload.slice(0, 45000) }, second = { ...a, parts: 2, part: 1, payload: a.payload.slice(45000) };
  assert.equal((await call(sync, 'push', first)).state, 'staging'); assert.equal((await call(sync, 'status')).revision, 1);
  const receipt=await call(sync,'receipt',{operationId:a.operationId});
  assert.deepEqual(receipt.received,[0]);assert.equal(receipt.parts,2);assert.equal(receipt.digest,a.digest);assert.equal(receipt.deviceId,a.deviceId);assert.equal(receipt.sequence,a.sequence);
  assert.equal((await call(sync, 'push', second)).state, 'committed');
  let rev = 1, offset = 0, payload = '';
  do { const p = await call(sync, 'pull', { revision: rev, offset }); assert.ok(Buffer.byteLength(JSON.stringify(p)) < 256 * 1024); payload += p.fragment; rev = p.revision; offset = p.offset; } while (offset);
  assert.equal(JSON.parse(payload)[0].raw, JSON.parse(a.payload)[0].raw);
});
test('answers from two devices add once and manual reset follows commit order', async () => {
  const sync = await create(); await call(sync, 'enable', { revision: 1 });
  const record = (collection, id, value, localRevision = 2) => ({ key: JSON.stringify([collection, id]), collection, id, raw: JSON.stringify(value), position: 0, localRevision, baseRevision: 0 });
  await call(sync, 'push', request([record('problemSets', 's', { id: 's', folderId: 'f' }), record('questions', 'q', { id: 'q', setId: 's' })]));
  const answer = (id, correct) => ({ id, questionId: 'q', setId: 's', folderId: 'f', selectedIndex: 0, isCorrect: correct, answeredAt: stamp, studyTimeZone: 'Asia/Tokyo' });
  const first = answer('a', true), second = answer('b', false);
  const event = (id, data, localRevision = 3) => record('localStorage', 'quizMake:sync-event:' + id, { kind: 'quiz-learning-event', questionId: 'q', ...data }, localRevision);
  const counter = { questionId: 'q', answeredCount: 1, correctCount: 1, wrongCount: 0 };
  const a = request([record('answerLogs', 'a', first), event('a', { action: 'answer', answer: first }), record('progress', 'q', counter)]);
  const b = request([record('answerLogs', 'b', second), event('b', { action: 'answer', answer: second }), record('progress', 'q', counter)]);
  await call(sync, 'push', a); await call(sync, 'push', b); await call(sync, 'push', a);
  const progress = async () => JSON.parse((await pg.query("select raw from private.quiz_sync_records where sync_id=$1 and collection='progress'", [sync])).rows[0].raw);
  assert.equal((await progress()).answeredCount, 2); assert.equal((await progress()).correctCount, 1); assert.equal((await progress()).wrongCount, 1);
  await call(sync, 'push', request([record('answerLogs', 'a', first), event('duplicate-a', { action: 'answer', answer: first })]));
  assert.equal((await progress()).answeredCount, 2);
  await call(sync, 'push', request([event('reset', { action: 'reset', value: { ...await progress(), answeredCount: 0, correctCount: 0, wrongCount: 0 } })]));
  assert.equal((await progress()).answeredCount, 0);
  await call(sync, 'push', request([event('manual', { action: 'patch', patch: { isAmbiguous: true, answeredCount: 99 } })]));
  assert.equal((await progress()).answeredCount, 0); assert.equal((await progress()).isAmbiguous, true);
});
test('parent deletion and a stale dependent edit preserve rescue bytes without orphaning live data', async () => {
  const sync = await create(); await call(sync, 'enable', { revision: 1 });
  const record = (collection, id, raw) => ({ key: JSON.stringify([collection, id]), collection, id, raw: raw === null ? null : JSON.stringify(raw), position: 0, localRevision: 2, baseRevision: 1 });
  await call(sync, 'push', request([record('problemSets', 's', { id: 's', folderId: 'f' }), record('questions', 'q', { id: 'q', setId: 's', question: 'old' })]));
  await call(sync, 'push', request([record('problemSets', 's', null)]));
  assert.equal((await pg.query("select raw from private.quiz_sync_records where sync_id=$1 and collection='questions'", [sync])).rows[0].raw, null);
  const stale = request([record('questions', 'q', { id: 'q', setId: 's', question: 'unsent edit' })]);
  assert.equal((await call(sync, 'push', stale)).state, 'committed');
  assert.equal((await pg.query("select raw from private.quiz_sync_records where sync_id=$1 and collection='questions'", [sync])).rows[0].raw, null);
  const history = await call(sync, 'history', { key: '["questions","q"]' });
  assert.ok(history.rescues.some(row => JSON.parse(row.raw).question === 'unsent edit'));
});

test('large legacy-shaped upload commits thousands of progress rows and resumes the exact last part',async()=>{
  const sync=await create();await call(sync,'enable',{revision:1});
  const record=(collection,id,value)=>({key:JSON.stringify([collection,id]),collection,id,raw:JSON.stringify(value),position:0,localRevision:2,baseRevision:0});
  const rows=[record('problemSets','s',{id:'s',folderId:'f'})];
  for(let i=0;i<4500;i++){
    const qid='q'+i;rows.push(record('questions',qid,{id:qid,setId:'s',question:'検証'.repeat(500)}));
    rows.push(record('progress',qid,{questionId:qid,answeredCount:7,correctCount:4,wrongCount:3}));
    if(i<250){const answer={id:'a'+i,questionId:qid,isCorrect:true,selectedIndex:0,answeredAt:stamp};
      rows.push(record('answerLogs',answer.id,answer),record('localStorage','quizMake:sync-event:'+i,{kind:'quiz-learning-event',questionId:qid,action:'answer',answer}));}
  }
  const upload=request(rows),parts=upload.payload.match(/[\s\S]{1,24000}/g);let committed;
  assert.ok(Buffer.byteLength(upload.payload)>15_000_000);
  for(let part=0;part<parts.length-1;part++)assert.equal((await call(sync,'push',{...upload,parts:parts.length,part,payload:parts[part]})).state,'staging');
  const receipt=await call(sync,'receipt',{operationId:upload.operationId});assert.equal(receipt.received.length,parts.length-1);
  assert.equal((await call(sync,'status')).revision,1);
  const last={...upload,parts:parts.length,part:parts.length-1,payload:parts.at(-1)},start=performance.now();
  committed=await call(sync,'push',last);const finishMs=performance.now()-start;
  console.log(JSON.stringify({largeDelta:{records:rows.length,bytes:Buffer.byteLength(upload.payload),parts:parts.length,finishMs}}));
  assert.equal(committed.state,'committed');assert.ok(finishMs<30000,'final transaction stays below the production statement timeout');
  assert.deepEqual(await call(sync,'push',last),committed);
  const counts=(await pg.query("select collection,count(*)::integer n from private.quiz_sync_records where sync_id=$1 group by collection",[sync])).rows;
  assert.equal(counts.find(r=>r.collection==='questions').n,4500);assert.equal(counts.find(r=>r.collection==='progress').n,4500);
  for(const [qid,expected] of [['q0',1],['q4499',7]])assert.equal(JSON.parse((await pg.query("select raw from private.quiz_sync_records where sync_id=$1 and collection='progress' and record_id=$2",[sync,qid])).rows[0].raw).answeredCount,expected);
});
