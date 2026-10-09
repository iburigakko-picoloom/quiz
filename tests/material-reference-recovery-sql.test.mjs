import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
const pg=await createRecordProtocolDatabase();after(()=>pg.close());
await pg.exec('create role service_role;create schema storage;create table storage.objects(bucket_id text,name text,metadata jsonb)');
await pg.exec(await readFile(new URL('../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261009051418_material_reference_recovery.sql',import.meta.url),'utf8'));
const stamp='2026-10-09T00:00:00Z',sha='a'.repeat(64),path='11111111-1111-4111-8111-111111111111/'+sha+'.pdf';
const material={id:'material',title:'Synthetic PDF',pages:[{id:'page',kind:'pdf',pdfPage:1}]};
const index={kind:'quiz-material-index',version:1,problemSetId:'deleted',materials:[material],updatedAt:stamp};
const file={kind:'quiz-material-remote-file',version:1,materialId:'material',bucket:'quiz-material-pdfs',path,sha256:sha,size:40,updatedAt:stamp};
const row=(collection,id,raw)=>({key:JSON.stringify([collection,id]),collection,id,raw:raw===null?null:JSON.stringify(raw),position:0});
const old=[row('indexedDbNotes','quizMake:notes:deleted:__materials_v1',index),row('indexedDbNotes','quizMake:notes:deleted:__material_pdf_material',file)];
await pg.query('insert into storage.objects values($1,$2,$3)',['quiz-material-pdfs',path,JSON.stringify({size:40})]);
let counter=0;
async function fixture(extra=[]){
  const sync=(++counter).toString(16).padStart(36,'0');
  await pg.query('insert into public.quiz_sync_data(sync_id,data,updated_at,creator_hash) values($1,$2,$3,private.quiz_sync_actor_hash())',[sync,JSON.stringify({version:1,localStorage:{},indexedDbNotes:{}}),stamp]);
  await pg.query('insert into private.quiz_sync_heads values($1,10,$2,0,true,null,null)',[sync,stamp]);
  const rows=[row('problemSets','deleted',null),row('problemSets','target',{id:'target',folderId:'f'}),row('questions','q',{id:'q',setId:'target',question:'KEEP BODY',materialReferences:[{materialId:'material',pageId:'page'}]}),...extra];
  for(const x of rows)await pg.query('insert into private.quiz_sync_records values($1,$2,$3,$4,$5,$6,10)',[sync,x.key,x.collection,x.id,x.raw,x.position]);
  await pg.query('insert into private.quiz_sync_changes values($1,1,$2)',[sync,JSON.stringify(old)]);return sync;
}
const repair=(sync,rev=10,hash=sha)=>pg.query('select private.quiz_recover_material_from_history($1,$2,$3,$4,1,$5) result',[sync,'material','target',rev,hash]);
const snapshot=async sync=>(await pg.query('select jsonb_agg(to_jsonb(r) order by record_key) rows from private.quiz_sync_records r where sync_id=$1',[sync])).rows[0].rows;
test('exact historical material is added to the live copy; every original row and deletion tombstone survives',async()=>{
  const sync=await fixture(),before=await snapshot(sync),result=(await repair(sync)).rows[0].result;
  assert.deepEqual(result,{code:'recovered',revision:11,rows:2,references:1});
  const after=await snapshot(sync);for(const row of before)assert.deepEqual(after.find(x=>x.record_key===row.record_key),row);
  assert.equal(JSON.parse(after.find(x=>x.record_id==='quizMake:notes:target:__materials_v1').raw).problemSetId,'target');
  const backup=(await pg.query('select *,originals_sha256=encode(sha256(convert_to(originals::text,\'UTF8\')),\'hex\') verified from private.quiz_material_recovery_backups where sync_id=$1',[sync])).rows[0];
  assert.equal(backup.verified,true);assert.deepEqual(backup.originals.records,before);
  // Reconstitute the original rows in a separate table, then compare every field.
  await pg.exec('create temp table restored(like private.quiz_sync_records including all)');
  await pg.query('insert into restored select * from jsonb_populate_recordset(null::private.quiz_sync_records,$1)',[JSON.stringify(backup.originals.records)]);
  assert.deepEqual((await pg.query('select jsonb_agg(to_jsonb(r) order by record_key) rows from restored r')).rows[0].rows,before);await pg.exec('drop table restored');
  assert.deepEqual((await repair(sync)).rows[0].result,{code:'already_recovered',revision:11,rows:2});assert.deepEqual(await snapshot(sync),after);
});
test('unrelated target material survives the additive merge',async()=>{
  const existing={...index,problemSetId:'target',materials:[{id:'other',title:'Other',pages:[{id:'blank',kind:'blank'}]}]};
  const sync=await fixture([row('indexedDbNotes','quizMake:notes:target:__materials_v1',existing)]);await repair(sync);
  const idx=JSON.parse((await snapshot(sync)).find(x=>x.record_id==='quizMake:notes:target:__materials_v1').raw);assert.deepEqual(idx.materials,[...existing.materials,material]);
});
test('stale revisions and pending commits refuse recovery before backup or changes',async()=>{
  const sync=await fixture(),before=await snapshot(sync);await assert.rejects(repair(sync,9),/remote_changed/);
  await pg.query('insert into private.quiz_sync_operations values($1,\'11111111-1111-4111-8111-111111111111\',$2,10)',[sync,JSON.stringify({kind:'whole-commit',state:'staging'})]);
  await assert.rejects(repair(sync),/sync_busy/);assert.deepEqual(await snapshot(sync),before);
});
test('unproven page IDs and mismatched PDF hashes leave the entire dataset unchanged',async()=>{
  const sync=await fixture(),before=await snapshot(sync);await assert.rejects(repair(sync,10,'b'.repeat(64)),/historical_pdf_mismatch/);
  await pg.query('update private.quiz_sync_records set raw=$2 where sync_id=$1 and collection=\'questions\'',[sync,JSON.stringify({id:'q',setId:'target',materialReferences:[{materialId:'material',pageId:'unknown'}]})]);
  const bad=await snapshot(sync);await assert.rejects(repair(sync),/unproven_reference/);assert.deepEqual(await snapshot(sync),bad);
  assert.equal((await pg.query('select count(*)::integer n from private.quiz_material_recovery_backups where sync_id=$1',[sync])).rows[0].n,0);
});
test('a deleted target index, still-live source, or duplicate live material ID refuses any guessing',async()=>{
  for(const extra of [[row('indexedDbNotes','quizMake:notes:target:__materials_v1',null)],[row('indexedDbNotes','quizMake:notes:third:__materials_v1',{...index,problemSetId:'third'})]]){
    const sync=await fixture(extra),before=await snapshot(sync);await assert.rejects(repair(sync),/target_index_deleted|material_already_owned/);assert.deepEqual(await snapshot(sync),before);
  }
  const sync=await fixture();await pg.query('update private.quiz_sync_records set raw=\'{"id":"deleted"}\' where sync_id=$1 and collection=\'problemSets\' and record_id=\'deleted\'',[sync]);await assert.rejects(repair(sync),/source_owner_still_live/);
});
test('anon, authenticated and service_role cannot call recovery or read its private backups',async()=>{
  const sync=await fixture();for(const role of ['anon','authenticated','service_role']){
    await pg.exec(`set role ${role}`);await assert.rejects(repair(sync));await assert.rejects(pg.query('select * from private.quiz_material_recovery_backups'));await pg.exec('reset role');
  }
});
test('failure after archive insertion rolls back both the repair and the archive',async()=>{
  const sync=await fixture(),before=await snapshot(sync);
  await pg.exec("create function private.reject_recovery_test() returns trigger language plpgsql as $$begin raise exception 'test_failure';end$$;create trigger reject_recovery_test before insert on private.quiz_sync_changes for each row execute function private.reject_recovery_test()");
  await assert.rejects(repair(sync),/test_failure/);assert.deepEqual(await snapshot(sync),before);assert.equal((await pg.query('select count(*)::integer n from private.quiz_material_recovery_backups where sync_id=$1',[sync])).rows[0].n,0);
  await pg.exec('drop trigger reject_recovery_test on private.quiz_sync_changes;drop function private.reject_recovery_test()');
});
