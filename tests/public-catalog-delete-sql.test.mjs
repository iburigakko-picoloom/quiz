import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {publicationFailure} from '../src/utils/publicationProtocol.ts';
import {createPublicationDatabase,publicationCall as call,publicationMetadata,publicationQuestions,publicationOwner} from './helpers/publication-db.mjs';
const pg=await createPublicationDatabase();after(()=>pg.close());
for(const file of ['20261008151820_resumable_publication.sql','20261008172607_public_discovery.sql','20261009001541_public_discovery_reader_authorization.sql','20261009110333_public_catalog_soft_delete.sql'])await pg.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
const manage=(action,id=null,meta={},set=null)=>call(pg,'quiz_public_folder_manage',[action,id,JSON.stringify(meta),set,'[]'],['text','uuid','jsonb','uuid','jsonb']);
const publish=(local,visibility='link',extra={})=>call(pg,'publish_problem_set_versioned',[JSON.stringify({...publicationMetadata(local),visibility,...extra}),JSON.stringify(publicationQuestions(4))],['jsonb','jsonb']);
const search=()=>call(pg,'quiz_public_search',['','all','',0,null,'popular',0,30],['text','text','text','integer','integer','text','integer','integer']);
const folder=id=>call(pg,'quiz_public_folder',[id],['uuid']);
const mine=()=>call(pg,'quiz_public_mine',[],[]);
const create=async(local,name,sets)=>{const id=await manage('save',null,{local_folder_id:local,name});for(const set of sets)await manage('add',id,{},set.id);await manage('publish',id);return id;};
const deletion=async(id,include=false)=>{const f=await folder(id);return {expected_updated_at:f.updated_at,expected_set_ids:f.members.map(s=>s.id).sort(),include_standalone:include};};
const actor=id=>pg.query("select set_config('test.user',$1,false)",[id]);

test('a deleted public source has a nonretryable restore instruction and resumed publishers cannot complete or resurrect it',async()=>{
  const failure=publicationFailure('P0001','public set deleted; restore before publishing');assert.equal(failure.code,'deleted');assert.equal(failure.retryable,false);assert.match(failure.message,/復元/);
  const local='resumed-after-delete',set=await publish(local,'public'),meta={...publicationMetadata(local),visibility:'public'},questions=publicationQuestions(4),old=randomUUID();
  const begin=id=>call(pg,'quiz_publish_begin',[id,JSON.stringify(meta),4,'a'.repeat(64)],['uuid','jsonb','integer','text']);
  const part=(id,start,rows)=>call(pg,'quiz_publish_part',[id,start,JSON.stringify(rows)],['uuid','integer','jsonb']);
  const finish=id=>call(pg,'quiz_publish_finish',[id],['uuid']);
  await begin(old);await part(old,0,questions.slice(0,2));const current=(await mine()).sets.find(s=>s.id===set.id);await manage('delete_set',set.id,{expected_updated_at:current.updated_at});
  await part(old,2,questions.slice(2));await assert.rejects(finish(old),/publication_conflict|deleted/);assert.ok(!(await search()).sets.some(s=>s.id===set.id));await call(pg,'quiz_publish_cancel',[old],['uuid']);
  const fresh=randomUUID();await begin(fresh);await part(fresh,0,questions);await assert.rejects(finish(fresh),/deleted/);
  assert.equal((await pg.query('select current_version_id from public.shared_problem_sets where id=$1',[set.id])).rows[0].current_version_id,set.version_id);assert.equal((await pg.query('select count(*)::int n from private.quiz_publication_versions where set_id=$1',[set.id])).rows[0].n,1);
  await call(pg,'quiz_publish_cancel',[fresh],['uuid']);
});

test('folder deletion removes dedicated catalog sets and preserves standalone and other-folder destinations; restore stays private',async()=>{
  const dedicated=await publish('dedicated'),standalone=await publish('standalone','public'),multi=await publish('multi');
  const root=await create('root','Root',[dedicated,standalone,multi]),other=await create('other','Other',[multi]);
  const before=(await pg.query('select count(*)::int n from private.quiz_publication_versions')).rows[0].n;
  const preview=await folder(root);assert.equal(preview.retained_set_count,1);assert.equal(preview.standalone_set_count,1);
  await manage('delete',root,await deletion(root));
  const found=await search();assert.ok(!found.folders.some(f=>f.id===root));assert.ok(!found.sets.some(s=>s.id===dedicated.id));assert.ok(found.sets.some(s=>s.id===standalone.id));assert.ok(found.sets.some(s=>s.id===multi.id));assert.equal((await folder(other)).set_count,1);
  const deleted=(await mine()).folders.find(f=>f.id===root);assert.ok(deleted.deleted_at);await manage('restore',root,{expected_deleted_at:deleted.deleted_at});assert.equal((await folder(root)).published,false);assert.ok(!(await search()).sets.some(s=>s.id===dedicated.id));
  assert.equal((await pg.query('select count(*)::int n from private.quiz_publication_versions')).rows[0].n,before);
});

test('explicitly including standalone children is reversible, idempotent, and does not unshare a group original or erase import records',async()=>{
  const group=await call(pg,'create_quiz_group',['Kept group'],['text']);
  const set=await publish('cascade','public',{group_ids:[group.id],add_destinations:true});
  const id=await create('cascade-folder','Cascade',[set]);
  await call(pg,'quiz_public_record_import',[set.id,'20000000-0000-4000-8000-000000000001','copy'],['uuid','uuid','text']);
  const before=(await pg.query('select questions from private.quiz_publication_versions where id=$1',[set.version_id])).rows[0].questions;
  const plan=await deletion(id,true);await manage('delete',id,plan);await manage('delete',id,plan);
  assert.ok(!(await search()).sets.some(s=>s.id===set.id));assert.equal((await pg.query('select count(*)::int n from public.quiz_group_problem_sets where set_id=$1',[set.id])).rows[0].n,1);assert.equal((await pg.query('select count(*)::int n from public.problem_set_copies where set_id=$1',[set.id])).rows[0].n,1);
  await assert.rejects(manage('ready',id),/deleted/);await assert.rejects(manage('add',id,{},set.id),/deleted/);await assert.rejects(call(pg,'quiz_public_set_visibility',[set.id,true],['uuid','boolean']),/deleted/);
  // Delayed standalone publishers fail atomically; group-only updates still work.
  await assert.rejects(publish('cascade','public',{group_ids:[group.id],add_destinations:true}),/deleted/);await publish('cascade','group',{group_ids:[group.id],add_destinations:true});assert.ok(!(await search()).sets.some(s=>s.id===set.id));
  const d=(await mine()).folders.find(f=>f.id===id);await assert.rejects(manage('restore',id,{expected_deleted_at:'2000-01-01T00:00:00Z'}),/changed/);await manage('restore',id,{expected_deleted_at:d.deleted_at});await manage('restore',id,{expected_deleted_at:d.deleted_at});
  assert.equal((await folder(id)).published,false);assert.ok(!(await search()).sets.some(s=>s.id===set.id));assert.equal((await pg.query('select visibility from public.shared_problem_sets where id=$1',[set.id])).rows[0].visibility,'group');assert.deepEqual((await pg.query('select questions from private.quiz_publication_versions where id=$1',[set.version_id])).rows[0].questions,before);
  await manage('publish',id);assert.ok((await search()).sets.some(s=>s.id===set.id));
});

test('set deletion removes all public folder memberships without deleting records; restoration requires explicit re-add or publish',async()=>{
  const set=await publish('delete-set','public');const a=await create('set-a','A',[set]),b=await create('set-b','B',[set]);
  const s=(await mine()).sets.find(s=>s.id===set.id);await manage('delete_set',set.id,{expected_updated_at:s.updated_at});await manage('delete_set',set.id,{expected_updated_at:s.updated_at});
  assert.equal((await folder(a)).set_count,0);assert.equal((await folder(b)).set_count,0);assert.ok(!(await search()).sets.some(s=>s.id===set.id));
  const archived=(await mine()).sets.find(s=>s.id===set.id);assert.ok(archived.deleted_at);await manage('restore_set',set.id,{expected_deleted_at:archived.deleted_at});await manage('restore_set',set.id,{expected_deleted_at:archived.deleted_at});
  assert.ok(!(await search()).sets.some(s=>s.id===set.id));assert.equal((await folder(a)).set_count,0);assert.equal((await pg.query('select count(*)::int n from private.quiz_public_folder_sets where set_id=$1',[set.id])).rows[0].n,2);
  await manage('add',a,{},set.id);assert.equal((await folder(a)).set_count,1);assert.equal((await folder(b)).set_count,0);
});

test('changed folder membership or content rejects stale confirmation atomically, and anonymous/other owners cannot delete or restore',async()=>{
  const x=await publish('stale-x'),y=await publish('stale-y');const f=await create('stale-folder','Stale',[x]);const plan=await deletion(f,true);await manage('add',f,{},y.id);await assert.rejects(manage('delete',f,plan),/changed/);assert.equal((await folder(f)).published,true);
  const current=(await mine()).sets.find(s=>s.id===x.id);await assert.rejects(manage('delete_set',x.id,{expected_updated_at:'2000-01-01'}),/changed/);
  const outsider='00000000-0000-4000-8000-000000000002';await pg.query('insert into auth.users(id,email) values($1,$2)',[outsider,'outsider@example.test']);await actor(outsider);await pg.exec('set role authenticated');
  try{for(const action of ['delete','restore'])await assert.rejects(manage(action,f,plan),/not authorized/);for(const action of ['delete_set','restore_set'])await assert.rejects(manage(action,x.id,{expected_updated_at:current.updated_at}),/not authorized/);await assert.rejects(pg.query('select * from private.quiz_public_deleted_sets'),/permission denied/);}finally{await pg.exec('reset role');await actor(publicationOwner);}
  await manage('delete',f,await deletion(f,true));await actor('');await pg.exec('set role anon');
  try{await assert.rejects(folder(f),/not authorized/);await assert.rejects(manage('restore',f),/permission denied/);const found=await search();assert.ok(!found.folders.some(item=>item.id===f));assert.ok(!found.sets.some(s=>s.id===x.id));}finally{await pg.exec('reset role');await actor(publicationOwner);}
});
