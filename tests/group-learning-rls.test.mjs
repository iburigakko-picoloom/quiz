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
await pg.exec(await readFile(new URL('../supabase/migrations/20261009110331_group_library_counts.sql',import.meta.url),'utf8'));
const period=(await pg.query(`select (now() at time zone 'Asia/Tokyo')::date::text as "day",date_trunc('week',now() at time zone 'Asia/Tokyo')::date::text as "week"`)).rows[0];
const read=()=>call('quiz_group_learning_read',[group,period.day,period.week],['uuid','date','date']);
const setRead=()=>call('quiz_group_learning_set_read',[group,published.id],['uuid','uuid']);
const enable=(enabled,generation=null)=>call('quiz_group_progress_consent',[group,published.id,enabled,'copy',published.version_id,generation],['uuid','uuid','boolean','text','uuid','uuid']);
const update=(generation,levels=[1,1,1,1],today=2,week=5)=>call('quiz_group_learning_update',[group,published.id,generation,'copy',published.version_id,3,levels,today,week,period.day,period.week],['uuid','uuid','uuid','text','uuid','integer','integer[]','integer','integer','date','date']);
let consent,folder;

test('group material count unions owned sources and copies once per set across devices, excluding other groups and removed references',async()=>{
  const g='10000000-0000-4000-8000-000000000010',otherG='10000000-0000-4000-8000-000000000011';
  await actor(owner);
  await pg.query('insert into public.quiz_groups(id,owner_id,name) values($1,$3,$4),($2,$3,$4)',[g,otherG,owner,'Counts']);
  await pg.query('insert into public.quiz_group_members(group_id,user_id,role) values($1,$3,$5),($1,$4,$6),($2,$3,$5)',[g,otherG,owner,member,'owner','member']);
  const publishLocal=async(local,groups,visibility='group')=>call('publish_problem_set_versioned',[JSON.stringify({...payload,local_set_id:local,folder_path:[],group_ids:groups,visibility}),JSON.stringify(questions)],['jsonb','jsonb']);
  const a=await publishLocal('count-a',[g]),b=await publishLocal('count-b',[g]),outside=await publishLocal('count-outside',[otherG]),publicOnly=await publishLocal('count-public',[],'public');
  for(const [set,who,device] of [[a.id,owner,'d1'],[a.id,owner,'d2'],[a.id,member,'d1'],[a.id,member,'d2'],[outside.id,owner,'d1'],[publicOnly.id,owner,'d1']])await pg.query('insert into public.problem_set_copies(set_id,actor_id,installation_id,local_set_id) values($1,$2,$3,$4)',[set,who,device==='d1'?'20000000-0000-4000-8000-000000000001':'20000000-0000-4000-8000-000000000002',device]);
  const readCounts=()=>call('quiz_group_learning_read',[g,period.day,period.week],['uuid','date','date']);
  let state=await readCounts();assert.equal(state.members.find(m=>m.user_id===owner).imported_set_count,2);assert.equal(state.members.find(m=>m.user_id===member).imported_set_count,1);assert.equal(state.members.find(m=>m.user_id===owner).levels,null);
  // Adding another group destination does not inflate this group's count.
  await publishLocal('count-a',[g,otherG]);state=await readCounts();assert.equal(state.members.find(m=>m.user_id===owner).imported_set_count,2);
  await pg.query('delete from public.quiz_group_problem_sets where group_id=$1 and set_id=$2',[g,a.id]);state=await readCounts();assert.equal(state.members.find(m=>m.user_id===owner).imported_set_count,1);assert.equal(state.members.find(m=>m.user_id===member).imported_set_count,0);
  await pg.query('delete from public.shared_problem_sets where id=$1',[b.id]);assert.equal((await readCounts()).members.find(m=>m.user_id===owner).imported_set_count,0);
  await actor(outsider);await assert.rejects(readCounts(),/not authorized/);await actor(owner);
});
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

test('an owner links and explicitly shares the original without recording an import or touching another member; lost membership denies updates',async()=>{
  const ownGroup='10000000-0000-4000-8000-000000000002';await actor(owner);
  await pg.query('insert into public.quiz_groups(id,owner_id,name) values($1,$2,$3)',[ownGroup,owner,'Original source test']);
  await pg.query("insert into public.quiz_group_members(group_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')",[ownGroup,owner,member]);
  const source=await call('publish_problem_set_versioned',[JSON.stringify({...payload,local_set_id:'owned-original',group_ids:[ownGroup]}),JSON.stringify(questions)],['jsonb','jsonb']);
  assert.equal((await pg.query('select count(*)::int n from public.quiz_group_problem_sets where group_id=$1 and set_id=$2',[ownGroup,source.id])).rows[0].n,1);
  const copies=(await pg.query('select * from public.problem_set_copies')).rows;
  const other=(await pg.query('select * from private.quiz_group_progress_summaries where user_id<>$1 order by group_id,set_id,user_id',[owner])).rows;
  const before=await call('quiz_group_learning_set_read',[ownGroup,source.id],['uuid','uuid']);assert.equal(before.own.enabled,false);
  const c=await call('quiz_group_progress_consent',[ownGroup,source.id,true,'owned-original',source.version_id,null],['uuid','uuid','boolean','text','uuid','uuid']);
  const args=[ownGroup,source.id,c.generation,'owned-original',source.version_id,3,[1,1,1,1],2,5,period.day,period.week],types=['uuid','uuid','uuid','text','uuid','integer','integer[]','integer','integer','date','date'];
  await call('quiz_group_learning_update',args,types);const after=await call('quiz_group_learning_set_read',[ownGroup,source.id],['uuid','uuid']);
  assert.equal(after.own.copy_id,'owned-original');assert.deepEqual(after.members.find(m=>m.user_id===owner).levels,[1,1,1,1]);
  assert.deepEqual((await pg.query('select * from public.problem_set_copies')).rows,copies);assert.deepEqual((await pg.query('select * from private.quiz_group_progress_summaries where user_id<>$1 order by group_id,set_id,user_id',[owner])).rows,other);
  await actor(member);const seen=await call('quiz_group_learning_set_read',[ownGroup,source.id],['uuid','uuid']);
  assert.deepEqual(seen.members.find(m=>m.user_id===owner).levels,[1,1,1,1]);assert.equal(seen.members.find(m=>m.user_id===owner).imported,true);assert.equal(seen.own.enabled,false);assert.equal(seen.own.copy_id,null);
  await assert.rejects(call('quiz_group_learning_update',args,types),/consent changed/);
  await actor(outsider);await assert.rejects(call('quiz_group_learning_update',args,types),/not authorized/);await actor(owner);
  await pg.query('delete from public.quiz_group_members where group_id=$1 and user_id=$2',[ownGroup,owner]);await assert.rejects(call('quiz_group_learning_update',args,types),/not authorized/);
});
test('sharing one original into two groups does not share progress; consent and unsharing remain isolated by the live group relation',async()=>{
  const groups=['10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000005'];await actor(owner);
  for(const id of groups){await pg.query('insert into public.quiz_groups(id,owner_id,name) values($1,$2,$3)',[id,owner,'Multi-group source']);await pg.query("insert into public.quiz_group_members(group_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')",[id,owner,member]);}
  const source=await call('publish_problem_set_versioned',[JSON.stringify({...payload,local_set_id:'multi-group-original',group_ids:groups}),JSON.stringify(questions)],['jsonb','jsonb']);
  assert.equal((await pg.query('select count(*)::int n from public.quiz_group_problem_sets where set_id=$1',[source.id])).rows[0].n,2);
  for(const id of groups)assert.equal((await call('quiz_group_learning_set_read',[id,source.id],['uuid','uuid'])).own.enabled,false);
  const copies=(await pg.query('select * from public.problem_set_copies')).rows;
  const c=await call('quiz_group_progress_consent',[groups[0],source.id,true,'multi-group-original',source.version_id,null],['uuid','uuid','boolean','text','uuid','uuid']);
  const args=[groups[0],source.id,c.generation,'multi-group-original',source.version_id,3,[1,1,1,1],2,5,period.day,period.week],types=['uuid','uuid','uuid','text','uuid','integer','integer[]','integer','integer','date','date'];
  await call('quiz_group_learning_update',args,types);
  const second=await call('quiz_group_learning_set_read',[groups[1],source.id],['uuid','uuid']);assert.equal(second.own.enabled,false);assert.equal(second.members.find(m=>m.user_id===owner).levels,null);
  await pg.query('delete from public.quiz_group_problem_sets where group_id=$1 and set_id=$2',[groups[0],source.id]);
  await assert.rejects(call('quiz_group_learning_update',args,types),/not authorized/);await assert.rejects(call('quiz_group_learning_set_read',[groups[0],source.id],['uuid','uuid']),/not authorized/);
  assert.equal((await call('quiz_group_learning_set_read',[groups[1],source.id],['uuid','uuid'])).own.enabled,false);
  assert.deepEqual((await pg.query('select * from public.problem_set_copies')).rows,copies);
});
