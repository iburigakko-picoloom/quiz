import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
const pg=await createRecordProtocolDatabase();after(()=>pg.close());
await pg.exec('create role service_role');
await pg.exec(await readFile(new URL('../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261007105000_quiz_whole_finish_typed_rows.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261007012207_quiz_record_pull_bounded.sql',import.meta.url),'utf8'));
const id='a'.repeat(36),stamp='2026-10-07T00:00:00Z';
const app={version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]};
await pg.query('insert into public.quiz_sync_data(sync_id,data,updated_at,creator_hash) values($1,$2,$3,private.quiz_sync_actor_hash())',[id,JSON.stringify({version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(app)},indexedDbNotes:{}}),stamp]);
await pg.query('select public.quiz_sync_v2_open($1,$2)',[id,stamp]);
const large=JSON.stringify({version:1,text:'語'.repeat(350000)});
for(let revision=1;revision<=2;revision++){
  const changes=[{key:JSON.stringify(['indexedDbNotes','qa-'+revision]),collection:'indexedDbNotes',id:'qa-'+revision,raw:large,position:revision,revision}];
  await pg.query('insert into private.quiz_sync_changes(sync_id,revision,changes) values($1,$2,$3)',[id,revision,JSON.stringify(changes)]);
}
await pg.query('update private.quiz_sync_heads set revision=2 where sync_id=$1',[id]);
const pull=async(cursor,limit=20)=>(await pg.query('select public.quiz_sync_v2_pull($1,$2,$3) as result',[id,cursor,limit])).rows[0].result;
test('large old revision pages make progress without aggregating twenty versions or splitting a version',async()=>{
  await pg.exec('set role authenticated');
  const first=await pull(0);assert.equal(first.code,'ok');assert.equal(first.cursor,1);assert.equal(first.head,2);assert.equal(first.hasMore,true);assert.equal(first.batches.length,1);assert.equal(first.batches[0].changes[0].raw,large);
  const second=await pull(first.cursor);assert.equal(second.cursor,2);assert.equal(second.hasMore,false);assert.equal(second.batches.length,1);
  const done=await pull(second.cursor);assert.deepEqual(done.batches,[]);assert.equal(done.cursor,2);assert.equal(done.hasMore,false);
  await pg.exec('reset role');
});
test('invalid limits and cursors remain invalid, rather than silently becoming a valid read',async()=>{
  for(const limit of [null,0,21])assert.equal((await pull(0,limit)).code,'invalid_cursor');
  assert.equal((await pull(3)).code,'invalid_cursor');
});
test('ownership and whole-mode fence stay intact and the raw legacy reader remains inaccessible',async()=>{
  await pg.query("select set_config('test.actor','intruder',false)");await assert.rejects(pull(0),/sync_not_found/);
  await pg.query("select set_config('test.actor','owner',false)");
  await pg.query('select public.quiz_whole_open($1,2)',[id]);assert.equal((await pull(0)).code,'whole_required');
  assert.equal((await pg.query("select has_function_privilege('authenticated','private.quiz_sync_v2_pull_record(text,bigint,integer)','EXECUTE') as allowed")).rows[0].allowed,false);
});
