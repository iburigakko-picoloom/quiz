import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const pg=await PGlite.create();after(()=>pg.close());
const owner='00000000-0000-4000-8000-000000000001',member='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003',group='10000000-0000-4000-8000-000000000001';
await pg.exec(`
  create role anon;create role authenticated;create schema auth;create schema private;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
  grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
  create table public.quiz_profiles(user_id uuid primary key references auth.users on delete cascade,display_name text);
  create table public.quiz_groups(id uuid primary key,owner_id uuid,name text,updated_at timestamptz default now());
  create table public.quiz_group_members(group_id uuid references public.quiz_groups on delete cascade,user_id uuid references auth.users on delete cascade,role text default 'member',joined_at timestamptz default now(),primary key(group_id,user_id));
  create table public.shared_problem_sets(id uuid primary key default gen_random_uuid(),owner_id uuid references auth.users,local_set_id text,author_name text,title text,description text,subject text,audience text,difficulty text,creation_method text,source text,visibility text,question_count integer,add_count integer default 0,published_at timestamptz,updated_at timestamptz,folder_path jsonb,share_token text default gen_random_uuid()::text,unique(owner_id,local_set_id));
  create table public.shared_questions(id uuid primary key default gen_random_uuid(),set_id uuid references public.shared_problem_sets on delete cascade,position integer,question text,choices jsonb,answer_indexes integer[],answer_text text,explanation text,detailed_explanation text,source_page text,category text,difficulty text,distractors jsonb,shuffle_choices boolean,unique(set_id,position));
  create table public.quiz_group_problem_sets(group_id uuid references public.quiz_groups on delete cascade,set_id uuid references public.shared_problem_sets on delete cascade,shared_by uuid,primary key(group_id,set_id));
  create table public.problem_set_copies(set_id uuid,actor_id uuid,installation_id uuid,local_set_id text);
  create function public.is_quiz_group_member(p_group uuid,p_user uuid default auth.uid()) returns boolean language sql as $$ select exists(select 1 from public.quiz_group_members where group_id=p_group and user_id=p_user) $$;
  create function public.is_quiz_group_admin(p_group uuid,p_user uuid default auth.uid()) returns boolean language sql as $$ select exists(select 1 from public.quiz_group_members where group_id=p_group and user_id=p_user and role in ('owner','admin')) $$;
  insert into auth.users values('${owner}'),('${member}'),('${outsider}');
  insert into public.quiz_groups(id,owner_id,name) values('${group}','${owner}','Medicine');
  insert into public.quiz_group_members(group_id,user_id,role) values('${group}','${owner}','owner'),('${group}','${member}','member');
  insert into public.quiz_profiles values('${owner}','Owner'),('${member}','Member'),('${outsider}','Outsider');
  select set_config('test.user','${owner}',false);
`);
for(const file of ['20260909144728_multi_destination_publishing.sql','20260909105552_shared_read_fail_closed.sql','20261002113543_quiz_publication_versions_and_group_progress.sql']) await pg.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
const folderMigration=await readFile(new URL('../supabase/migrations/20260907021448_quiz_group_folders_and_invite_preview.sql',import.meta.url),'utf8');
await pg.exec(folderMigration.slice(0,folderMigration.indexOf('create function quiz_private.preview_invite')));
await pg.exec('revoke all on function public.manage_quiz_group_library(uuid,text,uuid,text,uuid) from public,anon;grant execute on function public.manage_quiz_group_library(uuid,text,uuid,text,uuid) to authenticated;');
async function call(name,args,types){return (await pg.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)+'::'+types[i]).join(',')}) result`,args)).rows[0].result;}
const actor=async id=>{await pg.query("select set_config('test.user',$1,false)",[id]);};
const payload={local_set_id:'local',author_name:'Owner',title:'Cardiology',visibility:'group',group_ids:[group],add_destinations:true,folder_path:[{id:'root',name:'CBT'},{id:'child',name:'Cardiology'}]};
const questions=Array.from({length:4},(_,i)=>({position:i,logical_id:'original-'+i,question:'Q'+i,choices:['A','B','C','D'],answer_indexes:[0],answer_text:'A',category:'Medicine',difficulty:'basic'}));
let published=await call('publish_problem_set_versioned',[JSON.stringify(payload),JSON.stringify(questions)],['jsonb','jsonb']);
await pg.exec(await readFile(new URL('../supabase/migrations/20261008142626_group_learning_ui.sql',import.meta.url),'utf8'));
const period=(await pg.query(`select (now() at time zone 'Asia/Tokyo')::date::text as "day",date_trunc('week',now() at time zone 'Asia/Tokyo')::date::text as "week"`)).rows[0];
const read=()=>call('quiz_group_learning_read',[group,period.day,period.week],['uuid','date','date']);
const setRead=()=>call('quiz_group_learning_set_read',[group,published.id],['uuid','uuid']);
const enable=(enabled,generation=null)=>call('quiz_group_progress_consent',[group,published.id,enabled,'copy',published.version_id,generation],['uuid','uuid','boolean','text','uuid','uuid']);
const update=(generation,levels=[1,1,1,1],today=2,week=5)=>call('quiz_group_learning_update',[group,published.id,generation,'copy',published.version_id,3,levels,today,week,period.day,period.week],['uuid','uuid','uuid','text','uuid','integer','integer[]','integer','integer','date','date']);
let consent,folder;
test('existing paths become group folders while source paths and question contents stay intact',async()=>{
  const state=await read();assert.equal(state.folders.length,2);const root=state.folders.find(row=>row.parent_folder_id===null),child=state.folders.find(row=>row.parent_folder_id!==null);assert.equal(child.parent_folder_id,root.id);assert.equal(state.placements[0].group_folder_id,child.id);
  const source=(await pg.query('select folder_path from public.shared_problem_sets where id=$1',[published.id])).rows[0];assert.deepEqual(source.folder_path,payload.folder_path);
});
test('empty folder creation, icon changes and placement are shared organization with server-enforced ownership',async()=>{
  folder=await call('manage_quiz_group_library',[group,'create',null,'Endocrine',null],['uuid','text','uuid','text','uuid']);
  assert.equal((await read()).folders.find(row=>row.id===folder).created_by,owner);
  await call('quiz_group_learning_icon',[group,'book','violet'],['uuid','text','text']);assert.equal((await read()).icon,'book');
  await call('quiz_group_learning_place',[group,published.id,folder],['uuid','uuid','uuid']);
  await actor(member);await assert.rejects(call('quiz_group_learning_icon',[group,'book','blue'],['uuid','text','text']),/not authorized/);
  await assert.rejects(call('quiz_group_learning_place',[group,published.id,null],['uuid','uuid','uuid']),/not authorized/);
  await actor(outsider);await assert.rejects(read(),/not authorized/);await actor(owner);
});
test('learning starts unknown; same-person copies deduplicate and sharing discloses only consenting aggregates',async()=>{
  assert.equal((await read()).members[1].today_count,null);
  await pg.query('insert into public.problem_set_copies values($1,$2,$3,$4),($1,$2,$5,$6)',[published.id,member,owner,'copy',outsider,'second-device-copy']);
  await actor(member);consent=await enable(true);await update(consent.generation);
  const state=await read();const own=state.members.find(row=>row.user_id===member);
  assert.deepEqual(own.levels,[1,1,1,1]);assert.equal(own.today_count,2);assert.equal(own.week_count,5);assert.equal(own.imported_set_count,1);assert.equal(own.shared_set_count,1);
  assert.equal(state.members.find(row=>row.user_id===owner).levels,null);
  assert.equal(state.folders.find(row=>row.id===folder).import_count,1);
  const detail=await setRead();assert.deepEqual(detail.members.find(row=>row.user_id===member).levels,[1,1,1,1]);assert.equal(detail.members.find(row=>row.user_id===member).imported,true);
});
test('invalid levels/periods, mismatched denominator and another account cannot update summaries',async()=>{
  for(const levels of [[1,1,1],[-1,1,1,3],[1,null,1,2],[0,0,0,0]]) await assert.rejects(update(consent.generation,levels),/invalid learning/);
  await assert.rejects(update(consent.generation,[1,1,1,1],6,5),/invalid learning/);
  await assert.rejects(call('quiz_group_learning_read',[group,'2020-01-01','2020-01-01'],['uuid','date','date']),/invalid learning period/);
  await actor(owner);await assert.rejects(update(consent.generation),/consent changed/);await actor(member);
});
test('placement changes preserve opted-in progress and published questions',async()=>{
  await actor(owner);const before=(await pg.query('select question from public.shared_questions where set_id=$1 order by position',[published.id])).rows;
  await call('quiz_group_learning_place',[group,published.id,null],['uuid','uuid','uuid']);
  await call('quiz_group_learning_place',[group,published.id,folder],['uuid','uuid','uuid']);await actor(member);
  assert.deepEqual((await read()).members.find(row=>row.user_id===member).levels,[1,1,1,1]);
  assert.deepEqual((await pg.query('select question from public.shared_questions where set_id=$1 order by position',[published.id])).rows,before);
});
test('previous day/week activity becomes unknown instead of a fabricated zero',async()=>{
  await pg.query("update private.quiz_group_progress_summaries set activity_day=$1::date-1,activity_week_start=$2::date-7 where user_id=$3",[period.day,period.week,member]);
  const row=(await read()).members.find(row=>row.user_id===member);assert.equal(row.today_count,null);assert.equal(row.week_count,null);assert.deepEqual(row.levels,[1,1,1,1]);
  await update(consent.generation);
});
test('OFF and old clients cannot leak stale Level0–3 or activity values',async()=>{
  await call('quiz_group_progress_update',[group,published.id,consent.generation,'copy',published.version_id,3],['uuid','uuid','uuid','text','uuid','integer']);assert.equal((await read()).members.find(row=>row.user_id===member).levels,null);
  await update(consent.generation);const old=consent.generation;await enable(false,old);assert.equal((await read()).members.find(row=>row.user_id===member).levels,null);await assert.rejects(update(old),/consent changed/);
  consent=await enable(true,(await setRead()).own.generation);await update(consent.generation);
});
test('new publication, membership loss and anonymous roles cannot expose old or private aggregates',async()=>{
  await actor(owner);published=await call('publish_problem_set_versioned',[JSON.stringify(payload),JSON.stringify(questions.map(q=>({...q,question:q.question+'new'})))],['jsonb','jsonb']);await actor(member);
  assert.equal((await read()).members.find(row=>row.user_id===member).levels,null);assert.equal((await setRead()).members.find(row=>row.user_id===member).state,'update_pending');
  await pg.exec('set role anon');await assert.rejects(read(),/permission denied/);await assert.rejects(setRead(),/permission denied/);await pg.exec('reset role;set role authenticated');await assert.rejects(pg.query('select * from private.quiz_group_progress_summaries'),/permission denied/);await pg.exec('reset role');
  await pg.query('delete from public.quiz_group_members where group_id=$1 and user_id=$2',[group,member]);await assert.rejects(read(),/not authorized/);
});
