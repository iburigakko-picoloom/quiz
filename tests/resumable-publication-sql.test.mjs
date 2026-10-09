import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createPublicationDatabase,publicationOwner,publicationQuestions,publicationMetadata,publicationCall as call} from './helpers/publication-db.mjs';
const pg=await createPublicationDatabase();after(()=>pg.close());
await pg.exec(await readFile(new URL('../supabase/migrations/20261008151820_resumable_publication.sql',import.meta.url),'utf8'));
const digest='a'.repeat(64);
const begin=(id,meta,total)=>call(pg,'quiz_publish_begin',[id,JSON.stringify(meta),total,digest],['uuid','jsonb','integer','text']);
const part=(id,start,q)=>call(pg,'quiz_publish_part',[id,start,JSON.stringify(q)],['uuid','integer','jsonb']);
const finish=id=>call(pg,'quiz_publish_finish',[id],['uuid']);
const status=id=>call(pg,'quiz_publish_status',[id],['uuid']);
async function publish(id,count,meta=publicationMetadata(id)) {await begin(id,meta,count);const qs=publicationQuestions(count);for(let start=0;start<count;start+=250)await part(id,start,qs.slice(start,start+250));return finish(id);}
test('small and 10,000-question publication are atomic immutable references, without shared row inserts',async()=>{
  for(const count of [5,1001,10000]) {
    const id=randomUUID();const result=await publish(id,count);assert.equal(result.state,'completed');assert.equal(result.is_current,true);
    const read=await call(pg,'get_shared_problem_set_versioned',[result.result.id,null],['uuid','text']);assert.equal(read.questions.length,count);assert.equal(read.question_count,count);
    assert.equal((await pg.query('select count(*)::int n from public.shared_questions where set_id=$1',[result.result.id])).rows[0].n,0);
  }
});
test('disconnected/restarted upload resumes from authoritative cursor; retries and duplicate finish do not duplicate questions',async()=>{
  const id=randomUUID(),meta=publicationMetadata(id),qs=publicationQuestions(300);await begin(id,meta,300);await part(id,0,qs.slice(0,250));
  assert.equal((await begin(id,meta,300)).uploaded,250);assert.equal((await part(id,0,qs.slice(0,250))).uploaded,250);
  assert.equal((await pg.query('select count(*)::int n from public.shared_problem_sets where local_set_id=$1',[id])).rows[0].n,0);
  await assert.rejects(finish(id),/publication_incomplete/);await assert.rejects(part(id,0,[{...qs[0],question:'Changed'}]),/publication_operation_changed/);
  await part(id,250,qs.slice(250));const first=await finish(id);assert.deepEqual(await finish(id),first);
  assert.equal((await pg.query('select count(*)::int n from private.quiz_publication_versions where set_id=$1',[first.result.id])).rows[0].n,1);
  assert.equal((await status(id)).uploaded,300);
});
test('batch failure rolls back its cursor and staging; original complete publication remains visible',async()=>{
  const local=randomUUID(),original=await publish(randomUUID(),10,publicationMetadata(local));const id=randomUUID(),qs=publicationQuestions(300);await begin(id,publicationMetadata(local),300);
  await part(id,0,qs.slice(0,250));await assert.rejects(part(id,250,qs.slice(250).map((q,i)=>i===0?{...q,answer_indexes:[99]}:q)),/publication_invalid_question/);
  assert.equal((await status(id)).uploaded,250);const read=await call(pg,'get_shared_problem_set',[original.result.id,null],['uuid','text']);assert.equal(read.questions.length,10);
  await part(id,250,qs.slice(250));const next=await finish(id);assert.equal(next.result.id,original.result.id);assert.notEqual(next.result.version_id,original.result.version_id);
  const old=await call(pg,'quiz_get_publication_version',[original.result.id,original.result.version_id,null],['uuid','uuid','text']);assert.equal(old.questions.length,10);
});
test('concurrent operations on one set and changed publication metadata are rejected',async()=>{
  const local=randomUUID(),id=randomUUID(),meta=publicationMetadata(local);await begin(id,meta,5);
  await assert.rejects(begin(randomUUID(),meta,5),/publication_busy/);await assert.rejects(begin(id,{...meta,title:'Changed'},5),/publication_operation_changed/);
  await part(id,0,publicationQuestions(5));await pg.query('insert into public.shared_problem_sets(owner_id,local_set_id,title) values($1,$2,$3)',[publicationOwner,local,'Concurrent']);await assert.rejects(finish(id),/publication_conflict/);
});
test('folder owner namespace, anonymous roles, account changes and direct staging access stay protected',async()=>{
  const other='00000000-0000-4000-8000-000000000002';await pg.query('insert into auth.users(id,email) values($1,$2)',[other,'other@example.test']);
  const id=randomUUID(),path=[{id:'same-folder-id',name:'English'}],result=await publish(id,5,{...publicationMetadata(id),folder_path:path});
  await pg.query("select set_config('test.user',$1,false)",[other]);await assert.rejects(begin(id,{...publicationMetadata(id),folder_path:path},5),/not authorized/);assert.equal((await status(id)).state,'missing');await assert.rejects(finish(id),/not authorized/);
  assert.equal(await call(pg,'unpublish_problem_set',[result.result.id],['uuid']),false);
  await pg.exec('set role anon');await assert.rejects(status(id),/permission denied/);await pg.exec('reset role;set role authenticated');await assert.rejects(pg.query('select * from private.quiz_publish_questions'),/permission denied/);await pg.exec('reset role');
  await pg.query("select set_config('test.user',$1,false)",[publicationOwner]);
});
test('legacy versioned RPC remains compatible and identical republish retains the exact version',async()=>{
  const meta=publicationMetadata(randomUUID()),qs=publicationQuestions(4);const first=await call(pg,'publish_problem_set_versioned',[JSON.stringify(meta),JSON.stringify(qs)],['jsonb','jsonb']);const next=await call(pg,'publish_problem_set_versioned',[JSON.stringify(meta),JSON.stringify(qs)],['jsonb','jsonb']);assert.equal(next.version_id,first.version_id);
  const legacy=await call(pg,'get_shared_problem_set',[first.id,null],['uuid','text']);assert.equal(legacy.questions[0].shuffle_choices,null);assert.deepEqual(legacy.questions[0].distractors,[]);
});
test('a PostgreSQL timeout inside a part rolls back all writes and can retry without duplicates',async()=>{
  const id=randomUUID(),qs=publicationQuestions(250);await begin(id,publicationMetadata(id),250);
  await pg.exec(`create function private.fixture_publish_timeout() returns trigger language plpgsql as $$begin if new.position=249 then raise exception 'canceling statement due to statement timeout' using errcode='57014';end if;return new;end $$;create trigger fixture_publish_timeout before insert on private.quiz_publish_questions for each row execute function private.fixture_publish_timeout();`);
  await assert.rejects(part(id,0,qs),error=>error.code==='57014');assert.equal((await status(id)).uploaded,0);assert.equal((await pg.query('select count(*)::int n from private.quiz_publish_questions where job_id=$1',[id])).rows[0].n,0);
  await pg.exec('drop trigger fixture_publish_timeout on private.quiz_publish_questions');await part(id,0,qs);await part(id,0,qs);assert.equal((await finish(id)).state,'completed');
});
test('legacy size counter matches a full audit after inserts, updates, rollback and delete',async()=>{
  const meta=publicationMetadata(randomUUID());const result=await call(pg,'publish_problem_set',[JSON.stringify(meta),JSON.stringify(publicationQuestions(10))],['jsonb','jsonb']);
  const audit=async()=>{const row=(await pg.query('select s.question_payload_bytes,(select coalesce(sum(pg_column_size(to_jsonb(q))),0) from public.shared_questions q where q.set_id=s.id) expected from public.shared_problem_sets s where id=$1',[result.id])).rows[0];assert.equal(row.question_payload_bytes,row.expected);};
  await audit();await pg.query('update public.shared_questions set explanation=$1 where set_id=$2 and position=0',['long '.repeat(300),result.id]);await audit();
  await assert.rejects(pg.query('update public.shared_questions set question=$1 where set_id=$2 and position=0',['x'.repeat(30001),result.id]),/invalid question content/);await audit();
  await pg.query('delete from public.shared_questions where set_id=$1 and position=0',[result.id]);await audit();
});
test('private staging quota, stale generation, and public-folder ownership do not leak incomplete content',async()=>{
  const id=randomUUID(),qs=publicationQuestions(100);await begin(id,publicationMetadata(id),100);
  await pg.query('update private.quiz_publish_jobs set payload_bytes=8388600 where id=$1',[id]);await assert.rejects(part(id,0,qs),/publication_payload_too_large/);assert.equal((await status(id)).uploaded,0);
  await call(pg,'quiz_publish_cancel',[id],['uuid']);await assert.rejects(finish(id),/publication_expired/);
  const other='00000000-0000-4000-8000-000000000002';const path=[{id:'owner-folder',name:'English'}],own=await publish(randomUUID(),4,{...publicationMetadata('owner-folder-set'),folder_path:path});
  await pg.query("select set_config('test.user',$1,false)",[other]);const separate=await publish(randomUUID(),4,{...publicationMetadata('other-folder-set'),owner_id:publicationOwner,folder_path:path});
  const owners=(await pg.query('select owner_id from public.shared_problem_sets where id=any($1::uuid[])',[ [own.result.id,separate.result.id] ])).rows.map(row=>row.owner_id);assert.ok(owners.includes(publicationOwner));assert.ok(owners.includes(other));
  await assert.rejects(call(pg,'move_published_set_folder',[own.result.id,'[]'],['uuid','jsonb']),/not authorized|not owned/);
  assert.equal(await call(pg,'unpublish_problem_set',[own.result.id],['uuid']),false);await pg.query("select set_config('test.user',$1,false)",[publicationOwner]);
});
test('multiple group destinations retain public visibility and existing links, but revoked membership blocks commit',async()=>{
  const g1=await call(pg,'create_quiz_group',['Group one'],['text']),g2=await call(pg,'create_quiz_group',['Group two'],['text']);const local=randomUUID();
  const first=await publish(randomUUID(),4,{...publicationMetadata(local),group_ids:[g1.id]});
  const second=await publish(randomUUID(),4,{...publicationMetadata(local),visibility:'group',group_ids:[g2.id],add_destinations:true});assert.equal(first.result.id,second.result.id);assert.equal(second.result.visibility,'public');assert.equal(first.result.version_id,second.result.version_id);
  assert.equal((await pg.query('select count(*)::int n from public.quiz_group_problem_sets where set_id=$1',[first.result.id])).rows[0].n,2);
  const id=randomUUID();await begin(id,{...publicationMetadata(randomUUID()),visibility:'group',group_ids:[g2.id]},4);await part(id,0,publicationQuestions(4));await pg.query('delete from public.quiz_group_members where group_id=$1 and user_id=$2',[g2.id,publicationOwner]);await assert.rejects(finish(id),/not authorized/);
});

test('a completed receipt becomes stale after visibility or folder changes even when content version is unchanged',async()=>{
  const id=randomUUID(),result=await publish(id,4);assert.equal((await status(id)).is_current,true);
  await pg.query("update public.shared_problem_sets set visibility='link',updated_at=updated_at+interval '1 second' where id=$1",[result.result.id]);
  assert.equal((await status(id)).is_current,false);assert.equal((await finish(id)).is_current,false);
});

test('combined group UI and publication migrations retain imported progress and folder references',async()=>{
  const integrated=await createPublicationDatabase();
  try {
    const folders=await readFile(new URL('../supabase/migrations/20260907021448_quiz_group_folders_and_invite_preview.sql',import.meta.url),'utf8');
    await integrated.exec(folders.slice(0,folders.indexOf('create function quiz_private.preview_invite')));
    await integrated.exec(await readFile(new URL('../supabase/migrations/20261008142626_group_learning_ui.sql',import.meta.url),'utf8'));
    await integrated.exec(await readFile(new URL('../supabase/migrations/20261008151820_resumable_publication.sql',import.meta.url),'utf8'));
    const group=await call(integrated,'create_quiz_group',['Combined'],['text']),meta={...publicationMetadata('combined'),group_ids:[group.id]},questions=publicationQuestions(4);
    const published=await call(integrated,'publish_problem_set_versioned',[JSON.stringify(meta),JSON.stringify(questions)],['jsonb','jsonb']);
    await call(integrated,'record_problem_set_copy',[published.id,randomUUID(),'copy'],['uuid','uuid','text']);
    const consent=await call(integrated,'quiz_group_progress_consent',[group.id,published.id,true,'copy',published.version_id,null],['uuid','uuid','boolean','text','uuid','uuid']);
    const period=(await integrated.query(`select (now() at time zone 'Asia/Tokyo')::date::text as "day",date_trunc('week',now() at time zone 'Asia/Tokyo')::date::text as "week"`)).rows[0];
    await call(integrated,'quiz_group_learning_update',[group.id,published.id,consent.generation,'copy',published.version_id,3,'{1,1,1,1}',2,5,period.day,period.week],['uuid','uuid','uuid','text','uuid','integer','integer[]','integer','integer','date','date']);
    const folder=await call(integrated,'manage_quiz_group_library',[group.id,'create',null,'Folder',null],['uuid','text','uuid','text','uuid']);
    await call(integrated,'quiz_group_learning_place',[group.id,published.id,folder],['uuid','uuid','uuid']);
    const again=await call(integrated,'publish_problem_set_versioned',[JSON.stringify(meta),JSON.stringify(questions)],['jsonb','jsonb']);assert.equal(again.version_id,published.version_id);
    const state=await call(integrated,'quiz_group_learning_read',[group.id,period.day,period.week],['uuid','date','date']);
    assert.deepEqual(state.members.find(m=>m.user_id===publicationOwner).levels,[1,1,1,1]);assert.equal(state.placements.find(p=>p.set_id===published.id).group_folder_id,folder);
    const content=await call(integrated,'get_shared_problem_set_versioned',[published.id,null],['uuid','text']);assert.equal(content.questions.length,4);assert.equal(content.import_count,1);
    assert.equal((await integrated.query('select count(*)::int n from public.shared_questions where set_id=$1',[published.id])).rows[0].n,0);
  } finally {await integrated.close();}
});
