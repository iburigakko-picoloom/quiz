import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
const pg=await createRecordProtocolDatabase();after(()=>pg.close());
await pg.exec('create role service_role');
await pg.exec(await readFile(new URL('../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
const stamp='2026-10-05T00:00:00Z',id='1'.repeat(36),oldId='2'.repeat(36);
const app={version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]};
const payload={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(app)},indexedDbNotes:{}};
await pg.query('insert into public.quiz_sync_data(sync_id,updated_at,creator_hash,data) values($1,$3,private.quiz_sync_actor_hash(),$4),($2,$3,private.quiz_sync_actor_hash(),$4)',[id,oldId,stamp,JSON.stringify(payload)]);
async function call(name,args,types){return (await pg.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)+'::'+types[i]).join(',')}) result`,args)).rows[0].result}
await call('quiz_sync_v2_open',[id,stamp],['text','timestamptz']);
const status=(sync=id)=>call('quiz_whole_status',[sync],['text']);
const open=(rev,sync=id)=>call('quiz_whole_open',[sync,rev],['text','bigint']);
const record=(key,name)=>({key:JSON.stringify(['folders',key]),collection:'folders',id:key,raw:JSON.stringify({id:key,name}),position:0});
const sha=text=>createHash('sha256').update(text).digest('hex');
async function prepare(rows,revision,sync=id){const raw=JSON.stringify(rows),commit=randomUUID(),part=randomUUID();const beginArgs=[sync,commit,revision,1,rows.length,sha(sha(raw)),'QA device'];return {commit,part,raw,beginArgs,begin:()=>call('quiz_whole_begin',beginArgs,['text','uuid','bigint','integer','integer','text','text']),upload:()=>call('quiz_whole_part',[sync,commit,part,0,raw],['text','uuid','uuid','integer','text']),finish:()=>call('quiz_whole_finish',[sync,commit],['text','uuid'])}}

test('whole mode fences old record and Snapshot writers only for its enabled dataset',async()=>{
  assert.equal((await status()).enabled,false);assert.equal((await open(99)).code,'conflict');assert.equal((await open(0)).code,'ok');
  assert.equal((await status()).enabled,true);
  assert.equal((await call('quiz_sync_v2_push',[id,JSON.stringify([])],['text','jsonb'])).code,'whole_required');
  assert.equal((await call('quiz_sync_v2_pull',[id,0,10],['text','bigint','integer'])).code,'whole_required');
  await assert.rejects(pg.query('update public.quiz_sync_data set data=$2 where sync_id=$1',[id,JSON.stringify(payload)]),/whole_required/);
  assert.equal((await call('quiz_sync_v2_open',[oldId,stamp],['text','timestamptz'])).code,'ok');
  assert.equal((await status(oldId)).enabled,false);assert.equal((await call('quiz_sync_v2_push',[oldId,JSON.stringify([])],['text','jsonb'])).code,'invalid');
});

test('parts are invisible until one complete commit and lost responses retry the same receipt',async()=>{
  const first=await prepare([record('a','A'),record('b','B')],0);assert.equal((await first.begin()).code,'ok');assert.equal((await first.begin()).state,'staging');
  assert.equal((await first.finish()).code,'incomplete');assert.equal((await first.upload()).code,'ok');assert.equal((await first.upload()).code,'ok');
  assert.equal((await status()).revision,0);assert.equal((await call('quiz_whole_read',[id,0,'',1],['text','bigint','text','integer'])).rows.length,0);
  const result=await first.finish();assert.equal(result.code,'ok');assert.equal(result.revision,1);assert.deepEqual(await first.finish(),result);assert.equal((await first.begin()).state,'committed');
  assert.equal((await status()).device,'QA device');assert.ok((await status()).savedAt);
  const page=await call('quiz_whole_read',[id,1,'',1],['text','bigint','text','integer']);assert.equal(page.rows.length,1);assert.equal(page.hasMore,true);
  const last=await call('quiz_whole_read',[id,1,page.afterKey,1],['text','bigint','text','integer']);assert.equal(last.rows.length,1);assert.equal(last.hasMore,false);
  assert.equal((await call('quiz_whole_read',[id,0,'',1],['text','bigint','text','integer'])).code,'conflict');
  assert.equal((await pg.query("select count(*)::integer n from private.quiz_sync_operations where operation->>'kind'='whole-part'")).rows[0].n,0,'committed parts are released');
});

test('whole replacement omits nonchosen records; stale revision and altered UUID retries cannot write',async()=>{
  const next=await prepare([record('c','C')],1);assert.equal((await next.begin()).code,'ok');assert.equal((await next.upload()).code,'ok');
  assert.equal((await call('quiz_whole_part',[id,next.commit,next.part,0,JSON.stringify([record('c','altered')])],['text','uuid','uuid','integer','text'])).code,'operation_reused');
  assert.equal((await next.finish()).code,'ok');
  const page=await call('quiz_whole_read',[id,2,'',200],['text','bigint','text','integer']);assert.deepEqual(page.rows.map(r=>r.id),['c']);
  const deleted=await pg.query('select raw from private.quiz_sync_records where sync_id=$1 and record_id=$2',[id,'a']);assert.equal(deleted.rows[0].raw,null);
  assert.equal((await (await prepare([record('d','stale')],1)).begin()).code,'conflict');
});

test('invalid and cross-account requests do not alter live data or allocate temporary parts',async()=>{
  const pending=await prepare([record('d','D')],2);assert.equal((await pending.begin()).code,'ok');
  assert.equal((await call('quiz_whole_part',[id,pending.commit,randomUUID(),0,'[{"key":"bad"}]'],['text','uuid','uuid','integer','text'])).code,'invalid');
  assert.equal((await call('quiz_whole_part',[id,pending.commit,randomUUID(),0,'not json'],['text','uuid','uuid','integer','text'])).code,'invalid');
  assert.equal((await (await prepare([],2)).begin()).code,'busy');
  await pg.query("select set_config('test.actor','intruder',false)");await assert.rejects(status(),/sync_not_found/);await assert.rejects(pending.upload(),/sync_not_found/);await assert.rejects(pending.finish(),/sync_not_found/);
  await pg.query("select set_config('test.actor','owner',false)");
  await pg.query("update private.quiz_sync_operations set operation=jsonb_set(operation,'{expiresAt}',to_jsonb('2000-01-01'::text)) where operation_id=$1",[pending.commit]);
  assert.equal((await pending.finish()).code,'expired');const next=await prepare([],2);assert.equal((await next.begin()).code,'ok');
  assert.equal((await next.upload()).code,'ok');assert.equal((await next.finish()).code,'ok');
});

test('permission matrix exposes only authenticated invoker RPCs; underlying bypass functions remain inaccessible',async()=>{
  const rows=(await pg.query("select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like 'quiz_whole_%' or p.proname in('quiz_sync_v2_push_record','quiz_sync_v2_pull_record')")).rows;
  for(const row of rows){assert.equal(row.anon,false,row.proname);assert.equal(row.service,false,row.proname);assert.ok(row.proconfig.includes('search_path=""'),row.proname);if(row.nspname==='public'){assert.equal(row.prosecdef,false);assert.equal(row.authenticated,true)}else if(['quiz_sync_v2_push_record','quiz_sync_v2_pull_record','quiz_whole_snapshot_fence'].includes(row.proname))assert.equal(row.authenticated,false)}
  await pg.exec('set role anon');await assert.rejects(status(),/permission denied/);await pg.exec('reset role');
});
