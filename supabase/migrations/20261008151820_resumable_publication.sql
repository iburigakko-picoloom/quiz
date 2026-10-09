-- Additive publication protocol. Production application requires staging validation.
-- Immutable published versions are authoritative; legacy rows are retained.
create schema if not exists quiz_private;
revoke all on schema quiz_private from public,anon;
grant usage on schema quiz_private to authenticated;

-- Fix the original quadratic trigger for legacy writers as well. One indexed
-- parent-row delta replaces a whole-set SUM on every question INSERT/UPDATE.
alter table public.shared_problem_sets add column question_payload_bytes bigint not null default 0 check(question_payload_bytes>=0);
update public.shared_problem_sets s set question_payload_bytes=totals.bytes
  from (select set_id,sum(pg_column_size(to_jsonb(q))) bytes from public.shared_questions q group by set_id) totals where s.id=totals.set_id;
create or replace function public.enforce_shared_question_payload_limit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare previous_bytes bigint:=0;next_bytes bigint:=0;total bigint;
begin
  if tg_op='DELETE' then
    update public.shared_problem_sets set question_payload_bytes=greatest(0,question_payload_bytes-pg_column_size(to_jsonb(old))) where id=old.set_id;
    return old;
  end if;
  if octet_length(new.question)>30000 or octet_length(new.answer_text)>30000 or octet_length(new.explanation)>90000 or octet_length(new.detailed_explanation)>180000 or octet_length(new.source_page)>1500 or octet_length(new.category)>360
    or exists(select 1 from jsonb_array_elements(new.choices) c where jsonb_typeof(c)<>'string' or octet_length(c #>> '{}')>12000)
    or cardinality(new.answer_indexes)<>(select count(distinct i) from unnest(new.answer_indexes) i)
    or exists(select 1 from unnest(new.answer_indexes) i where i<0 or i>=jsonb_array_length(new.choices)) then raise exception 'invalid question content'; end if;
  next_bytes:=pg_column_size(to_jsonb(new));
  if tg_op='UPDATE' then
    perform 1 from public.shared_problem_sets where id in (old.set_id,new.set_id) order by id for update;
    previous_bytes:=pg_column_size(to_jsonb(old));
    if old.set_id<>new.set_id then
      update public.shared_problem_sets set question_payload_bytes=greatest(0,question_payload_bytes-previous_bytes) where id=old.set_id;
      previous_bytes:=0;
    end if;
  end if;
  update public.shared_problem_sets set question_payload_bytes=question_payload_bytes+next_bytes-previous_bytes where id=new.set_id returning question_payload_bytes into total;
  if total>8388608 then raise exception 'problem set payload is too large'; end if;
  return new;
end $$;
create trigger quiz_shared_question_payload_delete before delete on public.shared_questions for each row execute function public.enforce_shared_question_payload_limit();

create table private.quiz_publish_jobs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  local_set_id text not null,
  metadata jsonb not null,
  content_digest text not null,
  total integer not null check(total between 1 and 50000),
  uploaded integer not null default 0 check(uploaded>=0 and uploaded<=total),
  payload_bytes bigint not null default 0 check(payload_bytes between 0 and 8388608),
  state text not null default 'uploading' check(state in ('uploading','completed','cancelled','expired')),
  base_set_id uuid,
  base_updated_at timestamptz,
  base_version_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 minutes'
);
create unique index quiz_publish_active_set_idx on private.quiz_publish_jobs(owner_id,local_set_id) where state='uploading';
create index quiz_publish_owner_idx on private.quiz_publish_jobs(owner_id,created_at);
create table private.quiz_publish_questions (
  job_id uuid not null references private.quiz_publish_jobs(id) on delete cascade,
  position integer not null,
  logical_id text not null,
  question jsonb not null,
  payload_bytes integer not null,
  primary key(job_id,position),
  unique(job_id,logical_id)
);
create table private.quiz_publish_parts (
  job_id uuid not null references private.quiz_publish_jobs(id) on delete cascade,
  start_position integer not null,
  count integer not null,
  digest text not null,
  primary key(job_id,start_position)
);
alter table private.quiz_publish_jobs enable row level security;
alter table private.quiz_publish_questions enable row level security;
alter table private.quiz_publish_parts enable row level security;
revoke all on private.quiz_publish_jobs,private.quiz_publish_questions,private.quiz_publish_parts from public,anon,authenticated;

create function quiz_private.publish_metadata(value jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare groups jsonb:=coalesce(value->'group_ids','[]');
begin
  if jsonb_typeof(value) is distinct from 'object' or char_length(trim(coalesce(value->>'local_set_id',''))) not between 1 and 200
    or char_length(trim(coalesce(value->>'title',''))) not between 1 and 160
    or coalesce(value->>'visibility','link') not in ('link','public','group')
    or jsonb_typeof(groups) is distinct from 'array' or jsonb_array_length(groups)>100
    or (value->>'visibility'='group' and jsonb_array_length(groups)=0) then raise exception 'publication_invalid_metadata'; end if;
  if value ? 'folder_path' and (jsonb_typeof(value->'folder_path') is distinct from 'array' or jsonb_array_length(value->'folder_path')>2) then raise exception 'publication_invalid_folder'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(value->'folder_path','[]')) p where jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'id') is distinct from 'string' or jsonb_typeof(p->'name') is distinct from 'string' or char_length(trim(p->>'id')) not between 1 and 200 or char_length(trim(p->>'name')) not between 1 and 200) then raise exception 'publication_invalid_folder'; end if;
  return jsonb_build_object('local_set_id',value->>'local_set_id','title',trim(value->>'title'),
    'author_name',left(coalesce(nullif(trim(value->>'author_name'),''),'Quiz Make ユーザー'),40),
    'description',left(coalesce(value->>'description',''),2000),'subject',left(coalesce(value->>'subject',''),80),
    'audience',left(coalesce(value->>'audience',''),80),'difficulty',left(coalesce(value->>'difficulty','basic'),40),
    'creation_method',case when value->>'creation_method' in ('manual','bulk','chatgpt','copy','import','public-copy') then value->>'creation_method' else 'manual' end,
    'source',left(coalesce(value->>'source',''),500),'visibility',coalesce(value->>'visibility','link'),
    'group_ids',groups,'add_destinations',coalesce((value->>'add_destinations')::boolean,false),'keep_visibility',coalesce((value->>'keep_visibility')::boolean,false))
    || case when value ? 'folder_path' then jsonb_build_object('folder_path',value->'folder_path') else '{}' end;
end $$;

create function quiz_private.publish_question(value jsonb,expected_position integer) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare q jsonb; answers integer[]; choices integer;
begin
  if jsonb_typeof(value) is distinct from 'object' or (value->>'position')::integer is distinct from expected_position
    or char_length(coalesce(value->>'logical_id','')) not between 1 and 200
    or jsonb_typeof(value->'choices') is distinct from 'array'
    or jsonb_typeof(value->'answer_indexes') is distinct from 'array'
    or jsonb_typeof(coalesce(value->'distractors','[]')) is distinct from 'array'
    or (value ? 'shuffle_choices' and jsonb_typeof(value->'shuffle_choices') not in ('boolean','null'))
  then raise exception 'publication_invalid_question'; end if;
  choices:=jsonb_array_length(value->'choices');
  select array_agg(v::integer order by v::integer) into answers from jsonb_array_elements_text(value->'answer_indexes') v;
  if choices not between 4 and 5 or cardinality(answers) is null or cardinality(answers)<1
    or cardinality(answers)<>(select count(distinct a) from unnest(answers) a)
    or exists(select 1 from unnest(answers) a where a<0 or a>=choices)
    or exists(select 1 from jsonb_array_elements(value->'choices') c where jsonb_typeof(c)<>'string' or octet_length(c #>> '{}')>12000)
    or jsonb_array_length(coalesce(value->'distractors','[]'))>50
    or exists(select 1 from jsonb_array_elements(coalesce(value->'distractors','[]')) d where jsonb_typeof(d)<>'string' or char_length(trim(d #>> '{}')) not between 1 and 10000)
  then raise exception 'publication_invalid_question'; end if;
  q:=jsonb_build_object('question',trim(coalesce(value->>'question','')),'choices',value->'choices','answer_indexes',answers,
    'answer_text',left(coalesce(value->>'answer_text',''),10000),'explanation',left(coalesce(value->>'explanation',''),30000),
    'detailed_explanation',left(coalesce(value->>'detailed_explanation',''),60000),'source_page',left(coalesce(value->>'source_page',''),500),
    'category',left(coalesce(value->>'category',''),120),'difficulty',left(coalesce(value->>'difficulty','basic'),40),
    'distractors',coalesce(value->'distractors','[]'),'shuffle_choices',(value->>'shuffle_choices')::boolean);
  if char_length(q->>'question') not between 1 and 10000 or octet_length(q->>'question')>30000 or octet_length(q->>'answer_text')>30000
    or octet_length(q->>'explanation')>90000 or octet_length(q->>'detailed_explanation')>180000
    or octet_length(q->>'source_page')>1500 or octet_length(q->>'category')>360 then raise exception 'publication_question_too_large'; end if;
  return q||jsonb_build_object('logical_id',value->>'logical_id','content_revision',encode(sha256(convert_to(q::text,'UTF8')),'hex'));
end $$;
revoke all on function quiz_private.publish_metadata(jsonb),quiz_private.publish_question(jsonb,integer) from public,anon,authenticated;

create function quiz_private.publish_status(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare j private.quiz_publish_jobs;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid();
  if not found then return jsonb_build_object('state','missing','uploaded',0); end if;
  return jsonb_build_object('id',j.id,'state',case when j.state='uploading' and j.expires_at<now() then 'expired' else j.state end,'uploaded',j.uploaded,'total',j.total,'result',j.result,
    'is_current',case when j.state='completed' then exists(select 1 from public.shared_problem_sets s where s.id=(j.result->>'id')::uuid and s.owner_id=auth.uid() and s.current_version_id=(j.result->>'version_id')::uuid and s.updated_at=(j.result->>'updated_at')::timestamptz) else null end);
end $$;

create function quiz_private.publish_begin(p_job_id uuid,p_set jsonb,p_total integer,p_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); meta jsonb; j private.quiz_publish_jobs; source public.shared_problem_sets; group_id text;
begin
  if actor is null then raise exception 'not authorized'; end if;
  meta:=quiz_private.publish_metadata(p_set);
  if p_job_id is null or p_total is null or p_total not between 1 and 50000 or p_digest is null or p_digest!~'^[a-f0-9]{64}$' then raise exception 'publication_invalid_request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text||'/'||(meta->>'local_set_id'),0));
  select * into j from private.quiz_publish_jobs where id=p_job_id for update;
  if found then
    if j.owner_id<>actor then raise exception 'not authorized'; end if;
    if j.metadata<>meta or j.content_digest<>p_digest or j.total<>p_total then raise exception 'publication_operation_changed'; end if;
    if j.state='uploading' then update private.quiz_publish_jobs set expires_at=now()+interval '30 minutes' where id=j.id; end if;
    return quiz_private.publish_status(j.id);
  end if;
  for group_id in select value from jsonb_array_elements_text(meta->'group_ids') loop
    if public.is_quiz_group_member(group_id::uuid,actor) is not true then raise exception 'not authorized'; end if;
  end loop;
  update private.quiz_publish_jobs set state='expired' where owner_id=actor and local_set_id=meta->>'local_set_id' and state='uploading' and expires_at<now();
  if exists(select 1 from private.quiz_publish_jobs where owner_id=actor and local_set_id=meta->>'local_set_id' and state='uploading') then raise exception 'publication_busy'; end if;
  select * into source from public.shared_problem_sets where owner_id=actor and local_set_id=meta->>'local_set_id';
  insert into private.quiz_publish_jobs(id,owner_id,local_set_id,metadata,content_digest,total,base_set_id,base_updated_at,base_version_id)
    values(p_job_id,actor,meta->>'local_set_id',meta,p_digest,p_total,source.id,source.updated_at,source.current_version_id);
  return quiz_private.publish_status(p_job_id);
end $$;

create function quiz_private.publish_part(p_job_id uuid,p_start integer,p_questions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.quiz_publish_jobs; existing private.quiz_publish_parts; digest text; count integer; bytes bigint;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid();
  if not found then raise exception 'not authorized'; end if;
  -- Match begin's lock order: set reservation, then job row, then publication.
  perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||'/'||j.local_set_id,0));
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid() for update;
  if not found then raise exception 'not authorized'; end if;
  if j.state='completed' then return quiz_private.publish_status(j.id); end if;
  if j.state<>'uploading' or j.expires_at<now() then raise exception 'publication_expired'; end if;
  if p_start is null or p_start<0 or jsonb_typeof(p_questions) is distinct from 'array' then raise exception 'publication_invalid_part'; end if;
  count:=jsonb_array_length(p_questions);
  if count not between 1 and 250 or p_start+count>j.total or octet_length(p_questions::text)>1048576 then raise exception 'publication_invalid_part'; end if;
  digest:=encode(sha256(convert_to(p_questions::text,'UTF8')),'hex');
  select * into existing from private.quiz_publish_parts where job_id=j.id and start_position=p_start;
  if found then
    if existing.digest<>digest or existing.count<>count then raise exception 'publication_operation_changed'; end if;
    return quiz_private.publish_status(j.id);
  end if;
  if p_start<>j.uploaded then raise exception 'publication_position_changed'; end if;
  with normalized as materialized (
    select p_start+ordinality::integer-1 position,quiz_private.publish_question(value,p_start+ordinality::integer-1) q from jsonb_array_elements(p_questions) with ordinality
  ) insert into private.quiz_publish_questions(job_id,position,logical_id,question,payload_bytes)
    select j.id,position,q->>'logical_id',q,octet_length(q::text) from normalized;
  select sum(payload_bytes) into bytes from private.quiz_publish_questions where job_id=j.id and position>=p_start;
  if j.payload_bytes+bytes>8388608 then raise exception 'publication_payload_too_large'; end if;
  insert into private.quiz_publish_parts values(j.id,p_start,count,digest);
  update private.quiz_publish_jobs set uploaded=uploaded+count,payload_bytes=payload_bytes+bytes,expires_at=now()+interval '30 minutes' where id=j.id;
  return quiz_private.publish_status(j.id);
end $$;

create function quiz_private.publish_finish(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.quiz_publish_jobs; source public.shared_problem_sets; target uuid; token text; version uuid; manifest jsonb; visibility text; requested_group text; published_updated_at timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid();
  if not found then raise exception 'not authorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||'/'||j.local_set_id,0));
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid() for update;
  if not found then raise exception 'not authorized'; end if;
  if j.state='completed' then return quiz_private.publish_status(j.id); end if;
  if j.state<>'uploading' or j.expires_at<now() then raise exception 'publication_expired'; end if;
  if j.uploaded<>j.total then raise exception 'publication_incomplete'; end if;
  select * into source from public.shared_problem_sets where owner_id=j.owner_id and local_set_id=j.local_set_id for update;
  if source.id is distinct from j.base_set_id or source.updated_at is distinct from j.base_updated_at or source.current_version_id is distinct from j.base_version_id then raise exception 'publication_conflict'; end if;
  for requested_group in select value from jsonb_array_elements_text(j.metadata->'group_ids') loop
    perform 1 from public.quiz_group_members m where m.group_id=requested_group::uuid and m.user_id=auth.uid() for share;
    if not found then raise exception 'not authorized'; end if;
  end loop;
  select jsonb_agg(question order by position) into manifest from private.quiz_publish_questions where job_id=j.id;
  if jsonb_array_length(manifest) is distinct from j.total then raise exception 'publication_incomplete'; end if;
  visibility:=case when (j.metadata->>'keep_visibility')::boolean and source.id is not null then source.visibility when (j.metadata->>'add_destinations')::boolean and source.visibility='public' then 'public' else j.metadata->>'visibility' end;
  insert into public.shared_problem_sets(owner_id,local_set_id,author_name,title,description,subject,audience,difficulty,creation_method,source,visibility,question_count,folder_path,published_at,updated_at)
    values(j.owner_id,j.local_set_id,j.metadata->>'author_name',j.metadata->>'title',j.metadata->>'description',j.metadata->>'subject',j.metadata->>'audience',j.metadata->>'difficulty',j.metadata->>'creation_method',j.metadata->>'source',visibility,j.total,coalesce(j.metadata->'folder_path','[]'),now(),now())
    on conflict(owner_id,local_set_id) do update set author_name=excluded.author_name,title=excluded.title,description=excluded.description,subject=excluded.subject,audience=excluded.audience,difficulty=excluded.difficulty,creation_method=excluded.creation_method,source=excluded.source,visibility=excluded.visibility,question_count=excluded.question_count,folder_path=case when j.metadata ? 'folder_path' then excluded.folder_path else public.shared_problem_sets.folder_path end,updated_at=now()
    where public.shared_problem_sets.id=j.base_set_id and public.shared_problem_sets.updated_at=j.base_updated_at and public.shared_problem_sets.current_version_id is not distinct from j.base_version_id
    returning id,share_token,updated_at into target,token,published_updated_at;
  if target is null then raise exception 'publication_conflict'; end if;
  if exists(select 1 from private.quiz_publication_versions where id=j.base_version_id and set_id=target and questions=manifest) then version:=j.base_version_id;
  else insert into private.quiz_publication_versions(set_id,questions) values(target,manifest) returning id into version; end if;
  if not (j.metadata->>'add_destinations')::boolean then delete from public.quiz_group_problem_sets where set_id=target; end if;
  for requested_group in select value from jsonb_array_elements_text(j.metadata->'group_ids') loop
    insert into public.quiz_group_problem_sets(group_id,set_id,shared_by) values(requested_group::uuid,target,j.owner_id) on conflict do nothing;
  end loop;
  update public.shared_problem_sets set current_version_id=version where id=target;
  update private.quiz_publish_jobs set state='completed',result=jsonb_build_object('id',target,'share_token',token,'version_id',version,'visibility',visibility,'updated_at',published_updated_at) where id=j.id;
  -- Only this job's temporary staging is retired. Existing versions/legacy rows remain.
  delete from private.quiz_publish_questions where job_id=j.id;
  delete from private.quiz_publish_parts where job_id=j.id;
  return quiz_private.publish_status(j.id);
end $$;

create function quiz_private.publish_cancel(p_job_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  update private.quiz_publish_jobs set state='cancelled' where id=p_job_id and owner_id=auth.uid() and state in ('uploading','expired');
  if not found then return false; end if;
  delete from private.quiz_publish_questions where job_id=p_job_id;
  delete from private.quiz_publish_parts where job_id=p_job_id;
  return true;
end $$;

create function public.quiz_publish_begin(p_job_id uuid,p_set jsonb,p_total integer,p_digest text) returns jsonb language sql security invoker set search_path='' as $$select quiz_private.publish_begin(p_job_id,p_set,p_total,p_digest);$$;
create function public.quiz_publish_part(p_job_id uuid,p_start integer,p_questions jsonb) returns jsonb language sql security invoker set search_path='' as $$select quiz_private.publish_part(p_job_id,p_start,p_questions);$$;
create function public.quiz_publish_finish(p_job_id uuid) returns jsonb language sql security invoker set search_path='' as $$select quiz_private.publish_finish(p_job_id);$$;
create function public.quiz_publish_status(p_job_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select quiz_private.publish_status(p_job_id);$$;
create function public.quiz_publish_cancel(p_job_id uuid) returns boolean language sql security invoker set search_path='' as $$select quiz_private.publish_cancel(p_job_id);$$;
do $$declare signature text;begin
  foreach signature in array array['publish_begin(uuid,jsonb,integer,text)','publish_part(uuid,integer,jsonb)','publish_finish(uuid)','publish_status(uuid)','publish_cancel(uuid)'] loop
    execute 'revoke all on function quiz_private.'||signature||' from public,anon';execute 'grant execute on function quiz_private.'||signature||' to authenticated';
    execute 'revoke all on function public.quiz_'||signature||' from public,anon';execute 'grant execute on function public.quiz_'||signature||' to authenticated';
  end loop;
end $$;

-- Existing clients continue using this RPC. Its transaction now scales linearly.
create or replace function public.publish_problem_set_versioned(p_set jsonb,p_questions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job uuid:=gen_random_uuid(); part jsonb; result jsonb; total integer; start integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if jsonb_typeof(p_questions) is distinct from 'array' then raise exception 'invalid questions'; end if;
  total:=jsonb_array_length(p_questions);
  perform quiz_private.publish_begin(job,p_set,total,encode(sha256(convert_to(p_questions::text,'UTF8')),'hex'));
  for start,part in select ((ordinality-1)/250)::integer*250,jsonb_agg(value order by ordinality) from jsonb_array_elements(p_questions) with ordinality group by ((ordinality-1)/250)::integer order by 1 loop
    perform quiz_private.publish_part(job,start,part);
  end loop;
  result:=quiz_private.publish_finish(job);
  return result->'result';
end $$;

-- One authorization check, then read the immutable version or the old projection.
create or replace function public.get_shared_problem_set(p_set_id uuid,p_share_token text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.shared_problem_sets; questions jsonb; allowed boolean;
begin
  select * into s from public.shared_problem_sets where id=p_set_id;
  if not found then return null; end if;
  allowed:=s.visibility='public' or s.owner_id=auth.uid() or (p_share_token is not null and p_share_token=s.share_token)
    or exists(select 1 from public.quiz_group_problem_sets gp where gp.set_id=s.id and public.is_quiz_group_member(gp.group_id));
  if allowed is not true then raise exception 'not authorized'; end if;
  if s.current_version_id is not null then
    select v.questions into questions from private.quiz_publication_versions v where v.id=s.current_version_id and v.set_id=s.id;
    if questions is null then raise exception 'publication version unavailable'; end if;
  else select coalesce(jsonb_agg(to_jsonb(q)-array['id','set_id','position','created_at','updated_at'] order by q.position),'[]') into questions from public.shared_questions q where q.set_id=s.id;
  end if;
  return (to_jsonb(s)-array['share_token','local_set_id','current_version_id','question_payload_bytes'])||jsonb_build_object('version_id',s.current_version_id,'questions',questions);
end $$;
create or replace function public.get_shared_problem_set_versioned(p_set_id uuid,p_share_token text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  return public.get_shared_problem_set(p_set_id,p_share_token)||jsonb_build_object('import_count',(select count(distinct actor_id) from public.problem_set_copies where set_id=p_set_id));
end $$;
