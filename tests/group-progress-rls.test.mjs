import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const pg=await PGlite.create(); after(()=>pg.close());
const owner='00000000-0000-4000-8000-000000000001', member='00000000-0000-4000-8000-000000000002', outsider='00000000-0000-4000-8000-000000000003', group='10000000-0000-4000-8000-000000000001';
await pg.exec(`
  create role anon; create role authenticated; create schema auth; create schema private;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
  grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
  create table public.quiz_profiles(user_id uuid primary key references auth.users on delete cascade,display_name text);
  create table public.quiz_groups(id uuid primary key);
  create table public.quiz_group_members(group_id uuid references public.quiz_groups on delete cascade,user_id uuid references auth.users on delete cascade,role text default 'member',joined_at timestamptz default now(),primary key(group_id,user_id));
  create table public.shared_problem_sets(id uuid primary key default gen_random_uuid(),owner_id uuid references auth.users,local_set_id text,author_name text,title text,description text,subject text,audience text,difficulty text,creation_method text,source text,visibility text,question_count integer,add_count integer default 0,published_at timestamptz,updated_at timestamptz,folder_path jsonb,share_token text default gen_random_uuid()::text,unique(owner_id,local_set_id));
  create table public.shared_questions(id uuid primary key default gen_random_uuid(),set_id uuid references public.shared_problem_sets on delete cascade,position integer,question text,choices jsonb,answer_indexes integer[],answer_text text,explanation text,detailed_explanation text,source_page text,category text,difficulty text,distractors jsonb,shuffle_choices boolean,unique(set_id,position));
  create table public.quiz_group_problem_sets(group_id uuid references public.quiz_groups on delete cascade,set_id uuid references public.shared_problem_sets on delete cascade,shared_by uuid,primary key(group_id,set_id));
  create function public.is_quiz_group_member(p_group uuid,p_user uuid default auth.uid()) returns boolean language sql as $$ select exists(select 1 from public.quiz_group_members where group_id=p_group and user_id=p_user) $$;
  insert into auth.users values('${owner}'),('${member}'),('${outsider}');
  insert into public.quiz_groups values('${group}');
  insert into public.quiz_group_members(group_id,user_id) values('${group}','${owner}'),('${group}','${member}');
  insert into public.quiz_profiles values('${owner}','Owner'),('${member}','Member'),('${outsider}','Outsider');
  select set_config('test.user','${owner}',false);
`);
for(const file of ['20260909144728_multi_destination_publishing.sql','20260909105552_shared_read_fail_closed.sql','20261002113543_quiz_publication_versions_and_group_progress.sql'])await pg.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
async function call(name,args,types){return (await pg.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)+'::'+types[i]).join(',')}) result`,args)).rows[0].result;}
const actor=async id=>{await pg.query("select set_config('test.user',$1,false)",[id]);};
const payload={local_set_id:'local',author_name:'Owner',title:'English',visibility:'group',group_ids:[group],add_destinations:true};
const questions=[{position:0,logical_id:'original-q1',question:'What?',choices:['A','B','C','D'],answer_indexes:[0],answer_text:'A',category:'English',difficulty:'basic'}];
let published, consent;
const publish=q=>call('publish_problem_set_versioned',[JSON.stringify(payload),JSON.stringify(q)],['jsonb','jsonb']);
const read=()=>call('quiz_group_progress_read',[group,published.id],['uuid','uuid']);
const enable=(on,token=null,copy='copy-one',version=published.version_id)=>call('quiz_group_progress_consent',[group,published.id,on,copy,version,token],['uuid','uuid','boolean','text','uuid','uuid']);
const update=(token,copy='copy-one',version=published.version_id,count=1)=>call('quiz_group_progress_update',[group,published.id,token,copy,version,count],['uuid','uuid','uuid','text','uuid','integer']);
test('publication retains immutable logical IDs and exact versions through identical republish and destination updates',async()=>{
  published=await publish(questions); const first=await call('get_shared_problem_set_versioned',[published.id,null],['uuid','text']);
  assert.equal(first.version_id,published.version_id);assert.equal(first.questions[0].logical_id,'original-q1');assert.match(first.questions[0].content_revision,/^[a-f0-9]{64}$/);
  assert.equal((await publish(questions)).version_id,published.version_id);
  assert.equal((await pg.query('select count(*)::int count from private.quiz_publication_versions')).rows[0].count,1);
  const before=published.version_id;published=await publish([{...questions[0],question:'Changed?'}]);assert.notEqual(published.version_id,before);
  const old=await call('quiz_get_publication_version',[published.id,before,null],['uuid','uuid','text']);assert.equal(old.questions[0].question,'What?');
});
test('sharing starts OFF and requires explicit own consent, and aggregates disclose no private answers or plans',async()=>{
  await actor(member); const initial=await read();assert.equal(initial.own.enabled,false);assert.equal(initial.members[0].answered,null);
  await assert.rejects(update('20000000-0000-4000-8000-000000000001'),/consent changed/);
  consent=await enable(true);assert.equal(consent.enabled,true);await update(consent.generation);
  const state=await read();const own=state.members.find(m=>m.user_id===member);assert.equal(own.answered,1);assert.equal(own.total,1);assert.equal(own.state,'shared');
  assert.deepEqual(Object.keys(own).sort(),['answered','display_name','reflected_at','state','total','user_id']);
  assert.equal(state.members.find(m=>m.user_id===owner).answered,null);
});
test('self-only updates reject changed copy, version, excessive denominator and other accounts',async()=>{
  await assert.rejects(update(consent.generation,'other-copy'),/consent changed/);
  await assert.rejects(update(consent.generation,'copy-one',published.version_id,2),/invalid aggregate/);
  await actor(owner); await assert.rejects(update(consent.generation),/consent changed/);
  await actor(outsider);await assert.rejects(read(),/not authorized/);await assert.rejects(enable(true),/not authorized/);await assert.rejects(update(consent.generation),/not authorized/);
  await actor(member);
});
test('OFF rotates a tombstone generation; delayed update and retried initial ON cannot resurrect sharing',async()=>{
  const old=consent.generation;const off=await enable(false,old);assert.equal(off.enabled,false);assert.notEqual(off.generation,old);
  await assert.rejects(update(old),/consent changed/);await assert.rejects(enable(true,old),/consent changed/);await assert.rejects(enable(true,null),/consent changed/);
  const rows=await read();assert.equal(rows.own.enabled,false);assert.equal(rows.members.find(m=>m.user_id===member).answered,null);
  consent=await enable(true,off.generation);await update(consent.generation);
});
test('departing hides the member and revokes tokens even after rejoining',async()=>{
  const old=consent.generation;await pg.query('delete from public.quiz_group_members where group_id=$1 and user_id=$2',[group,member]);
  await assert.rejects(read(),/not authorized/);await assert.rejects(update(old),/not authorized/);
  await actor(owner);assert.equal((await read()).members.some(m=>m.user_id===member),false);
  await pg.query('insert into public.quiz_group_members(group_id,user_id) values($1,$2)',[group,member]);await actor(member);
  assert.equal((await read()).own.enabled,false);await assert.rejects(update(old),/consent changed/);
  consent=await enable(true,(await read()).own.generation);await update(consent.generation);
});
test('unlinked materials block reads and revoke sharing on reattachment',async()=>{
  const old=consent.generation;await pg.query('delete from public.quiz_group_problem_sets where group_id=$1 and set_id=$2',[group,published.id]);await assert.rejects(read(),/not authorized/);
  await pg.query('insert into public.quiz_group_problem_sets(group_id,set_id,shared_by) values($1,$2,$3)',[group,published.id,owner]);
  assert.equal((await read()).own.enabled,false);await assert.rejects(update(old),/consent changed/);
  consent=await enable(true,(await read()).own.generation);await update(consent.generation);
});
test('changed publication and legacy publishing report pending instead of zero or stale progress',async()=>{
  await actor(owner);const oldVersion=published.version_id;published=await publish([{...questions[0],question:'New edition?'}]);await actor(member);
  assert.equal((await read()).members.find(m=>m.user_id===member).state,'update_pending');await assert.rejects(update(consent.generation,'copy-one',oldVersion),/publication version unavailable/);
  await actor(owner);await call('publish_problem_set',[JSON.stringify(payload),JSON.stringify(questions)],['jsonb','jsonb']);await actor(member);
  const state=await read();assert.equal(state.version_id,null);assert.equal(state.members.find(m=>m.user_id===member).answered,null);await assert.rejects(enable(true,consent.generation),/publication version unavailable/);
});
test('API roles cannot access private rows or anonymously invoke progress RPCs; deleted accounts cannot resurrect summaries',async()=>{
  await pg.exec('set role anon');await assert.rejects(read(),/permission denied/);await assert.rejects(enable(false),/permission denied/);await assert.rejects(pg.query('select * from private.quiz_group_progress_summaries'),/permission denied/);
  await pg.exec('reset role;set role authenticated');await assert.rejects(pg.query('update private.quiz_group_progress_consent set enabled=true'),/permission denied/);await assert.rejects(pg.query('select * from private.quiz_publication_versions'),/permission denied/);await pg.exec('reset role');
  await pg.query('delete from auth.users where id=$1',[member]);await assert.rejects(update(consent.generation),/not authorized/);assert.equal((await pg.query('select count(*)::int count from private.quiz_group_progress_summaries where user_id=$1',[member])).rows[0].count,0);
});
