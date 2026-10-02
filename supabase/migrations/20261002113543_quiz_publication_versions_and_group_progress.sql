-- QuizMake only. Requires a separate production permission review before applying.
-- No existing answers, consent, Auth settings or Poker tables are migrated.
create schema if not exists private;
alter table public.shared_problem_sets add column if not exists current_version_id uuid;
alter table public.shared_questions add column if not exists logical_id text;
alter table public.shared_questions add column if not exists content_revision text;

create table private.quiz_publication_versions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.shared_problem_sets(id) on delete cascade,
  questions jsonb not null check (jsonb_typeof(questions) = 'array'),
  created_at timestamptz not null default now(),
  unique (set_id, id)
);
create table private.quiz_group_progress_consent (
  group_id uuid not null references public.quiz_groups(id) on delete cascade,
  set_id uuid not null references public.shared_problem_sets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  generation uuid not null default gen_random_uuid(),
  copy_id text,
  version_id uuid,
  updated_at timestamptz not null default now(),
  primary key (group_id, set_id, user_id)
);
create table private.quiz_group_progress_summaries (
  group_id uuid not null,
  set_id uuid not null,
  user_id uuid not null,
  generation uuid not null,
  version_id uuid not null,
  answered integer not null check (answered >= 0),
  total integer not null check (total > 0 and answered <= total),
  reflected_at timestamptz not null default now(),
  primary key (group_id, set_id, user_id),
  foreign key (group_id,set_id,user_id) references private.quiz_group_progress_consent(group_id,set_id,user_id) on delete cascade,
  foreign key (set_id,version_id) references private.quiz_publication_versions(set_id,id) on delete cascade
);
alter table private.quiz_publication_versions enable row level security;
alter table private.quiz_group_progress_consent enable row level security;
alter table private.quiz_group_progress_summaries enable row level security;
revoke all on private.quiz_publication_versions, private.quiz_group_progress_consent, private.quiz_group_progress_summaries from public, anon, authenticated;

-- Older publishers may still call the unversioned RPC. Such changes invalidate
-- the current version instead of attributing new content to an old version.
create function private.quiz_invalidate_publication_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.shared_problem_sets set current_version_id = null
  where id = coalesce(new.set_id,old.set_id) and current_version_id is not null;
  return null;
end $$;
revoke all on function private.quiz_invalidate_publication_version() from public, anon, authenticated;
create trigger quiz_invalidate_publication_version after insert or update or delete on public.shared_questions
for each row execute function private.quiz_invalidate_publication_version();

create function public.publish_problem_set_versioned(p_set jsonb, p_questions jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb; target uuid; version uuid; manifest jsonb; previous uuid;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if jsonb_typeof(p_questions) is distinct from 'array'
    or exists(select 1 from jsonb_array_elements(p_questions) q where char_length(coalesce(q->>'logical_id','')) not between 1 and 200)
    or (select count(distinct q->>'logical_id') from jsonb_array_elements(p_questions) q) <> jsonb_array_length(p_questions)
    or (select count(distinct q->>'position') from jsonb_array_elements(p_questions) q) <> jsonb_array_length(p_questions)
  then raise exception 'invalid logical question IDs'; end if;
  select current_version_id into previous from public.shared_problem_sets
  where owner_id=auth.uid() and local_set_id=p_set->>'local_set_id' for update;
  -- Reuse the existing ownership, payload, destination and member checks.
  result := public.publish_problem_set(p_set,p_questions);
  target := (result->>'id')::uuid;
  update public.shared_questions q set logical_id = item->>'logical_id'
  from jsonb_array_elements(p_questions) item
  where q.set_id=target and q.position=(item->>'position')::integer;
  update public.shared_questions q set content_revision = encode(sha256(convert_to(
    jsonb_build_object('question',q.question,'choices',q.choices,'answer_indexes',q.answer_indexes,
    'answer_text',q.answer_text,'explanation',q.explanation,'detailed_explanation',q.detailed_explanation,
    'source_page',q.source_page,'category',q.category,'difficulty',q.difficulty,
    'distractors',q.distractors,'shuffle_choices',q.shuffle_choices)::text,'UTF8')),'hex')
  where q.set_id=target;
  select jsonb_agg(jsonb_build_object('logical_id',q.logical_id,'content_revision',q.content_revision,
    'question',q.question,'choices',q.choices,'answer_indexes',q.answer_indexes,'answer_text',q.answer_text,
    'explanation',q.explanation,'detailed_explanation',q.detailed_explanation,'source_page',q.source_page,
    'category',q.category,'difficulty',q.difficulty,'distractors',q.distractors,'shuffle_choices',q.shuffle_choices) order by q.position)
  into manifest from public.shared_questions q where q.set_id=target;
  if exists(select 1 from private.quiz_publication_versions where id=previous and set_id=target and questions=manifest) then version:=previous;
  else insert into private.quiz_publication_versions(set_id,questions) values(target,manifest) returning id into version; end if;
  update public.shared_problem_sets set current_version_id=version where id=target;
  return result || jsonb_build_object('version_id',version);
end $$;

create function public.get_shared_problem_set_versioned(p_set_id uuid,p_share_token text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; version uuid; manifest jsonb;
begin
  -- Existing fail-closed access checks remain authoritative.
  result:=public.get_shared_problem_set(p_set_id,p_share_token);
  select current_version_id into version from public.shared_problem_sets where id=p_set_id;
  if version is null then return result; end if;
  select questions into manifest from private.quiz_publication_versions where id=version and set_id=p_set_id;
  if manifest is null then raise exception 'publication version unavailable'; end if;
  return result || jsonb_build_object('version_id',version,'questions',manifest);
end $$;

create function public.quiz_get_publication_version(p_set_id uuid,p_version_id uuid,p_share_token text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare manifest jsonb;
begin
  perform public.get_shared_problem_set(p_set_id,p_share_token);
  select questions into manifest from private.quiz_publication_versions where id=p_version_id and set_id=p_set_id;
  if manifest is null then raise exception 'publication version unavailable'; end if;
  return jsonb_build_object('set_id',p_set_id,'version_id',p_version_id,'questions',manifest);
end $$;

create function public.quiz_group_progress_consent(p_group_id uuid,p_set_id uuid,p_enabled boolean,p_copy_id text,p_version_id uuid,p_expected_generation uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); current_row private.quiz_group_progress_consent; token uuid:=gen_random_uuid();
begin
  if actor is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_group_members where group_id=p_group_id and user_id=actor for share;
  if not found then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_set_id for share;
  if not found then raise exception 'not authorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_group_id::text||p_set_id::text||actor::text,0));
  select * into current_row from private.quiz_group_progress_consent where group_id=p_group_id and set_id=p_set_id and user_id=actor for update;
  if current_row.generation is distinct from p_expected_generation then raise exception 'consent changed'; end if;
  if p_enabled is null then raise exception 'invalid consent'; end if;
  if p_enabled then
    if char_length(coalesce(p_copy_id,'')) not between 1 and 200
      or not exists(select 1 from public.shared_problem_sets s join private.quiz_publication_versions v on v.id=s.current_version_id and v.set_id=s.id where s.id=p_set_id and v.id=p_version_id)
    then raise exception 'publication version unavailable'; end if;
  end if;
  insert into private.quiz_group_progress_consent(group_id,set_id,user_id,enabled,generation,copy_id,version_id)
  values(p_group_id,p_set_id,actor,p_enabled,token,case when p_enabled then p_copy_id end,case when p_enabled then p_version_id end)
  on conflict(group_id,set_id,user_id) do update set enabled=excluded.enabled,generation=excluded.generation,copy_id=excluded.copy_id,version_id=excluded.version_id,updated_at=now();
  delete from private.quiz_group_progress_summaries where group_id=p_group_id and set_id=p_set_id and user_id=actor;
  return jsonb_build_object('generation',token,'enabled',p_enabled);
end $$;

create function public.quiz_group_progress_update(p_group_id uuid,p_set_id uuid,p_generation uuid,p_copy_id text,p_version_id uuid,p_answered integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); consent private.quiz_group_progress_consent; denominator integer;
begin
  if actor is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_group_members where group_id=p_group_id and user_id=actor for share;
  if not found then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_set_id for share;
  if not found then raise exception 'not authorized'; end if;
  select * into consent from private.quiz_group_progress_consent where group_id=p_group_id and set_id=p_set_id and user_id=actor for update;
  if consent.enabled is not true or consent.generation is distinct from p_generation or consent.copy_id is distinct from p_copy_id or consent.version_id is distinct from p_version_id then raise exception 'consent changed'; end if;
  select jsonb_array_length(v.questions) into denominator from private.quiz_publication_versions v join public.shared_problem_sets s on s.id=v.set_id and s.current_version_id=v.id where v.id=p_version_id and v.set_id=p_set_id;
  if denominator is null then raise exception 'publication version unavailable'; end if;
  if p_answered is null or p_answered < 0 or p_answered > denominator then raise exception 'invalid aggregate'; end if;
  insert into private.quiz_group_progress_summaries(group_id,set_id,user_id,generation,version_id,answered,total,reflected_at)
  values(p_group_id,p_set_id,actor,p_generation,p_version_id,p_answered,denominator,clock_timestamp())
  on conflict(group_id,set_id,user_id) do update set generation=excluded.generation,version_id=excluded.version_id,answered=excluded.answered,total=excluded.total,reflected_at=excluded.reflected_at;
  return true;
end $$;

create function public.quiz_group_progress_read(p_group_id uuid,p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); version uuid; own private.quiz_group_progress_consent; members jsonb;
begin
  if actor is null or not exists(select 1 from public.quiz_group_members where group_id=p_group_id and user_id=actor)
    or not exists(select 1 from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_set_id) then raise exception 'not authorized'; end if;
  select current_version_id into version from public.shared_problem_sets where id=p_set_id;
  select * into own from private.quiz_group_progress_consent where group_id=p_group_id and set_id=p_set_id and user_id=actor;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',coalesce(p.display_name,'メンバー'),
    'state',case when c.enabled is not true then 'not_shared' when version is null or c.version_id is distinct from version then 'update_pending' when a.generation=c.generation and a.version_id=version then 'shared' else 'reflection_pending' end,
    'answered',case when c.enabled and c.version_id=version and a.generation=c.generation and a.version_id=version then a.answered end,
    'total',case when c.enabled and c.version_id=version and a.generation=c.generation and a.version_id=version then a.total end,
    'reflected_at',case when c.enabled and c.version_id=version and a.generation=c.generation and a.version_id=version then a.reflected_at end) order by m.joined_at,m.user_id),'[]'::jsonb)
  into members from public.quiz_group_members m left join public.quiz_profiles p on p.user_id=m.user_id
    left join private.quiz_group_progress_consent c on c.group_id=m.group_id and c.set_id=p_set_id and c.user_id=m.user_id
    left join private.quiz_group_progress_summaries a on a.group_id=m.group_id and a.set_id=p_set_id and a.user_id=m.user_id
  where m.group_id=p_group_id;
  return jsonb_build_object('version_id',version,'members',members,'own',jsonb_build_object('generation',own.generation,'enabled',coalesce(own.enabled,false),'copy_id',own.copy_id,'version_id',own.version_id));
end $$;

-- Membership and material unlinking revoke consent even if a user later rejoins.
create function private.quiz_revoke_departed_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name='quiz_group_members' then
    update private.quiz_group_progress_consent set enabled=false,generation=gen_random_uuid(),copy_id=null,version_id=null,updated_at=now() where group_id=old.group_id and user_id=old.user_id;
  else
    update private.quiz_group_progress_consent set enabled=false,generation=gen_random_uuid(),copy_id=null,version_id=null,updated_at=now() where group_id=old.group_id and set_id=old.set_id;
  end if;
  return null;
end $$;
revoke all on function private.quiz_revoke_departed_progress() from public, anon, authenticated;
create trigger quiz_revoke_departed_progress after delete on public.quiz_group_members for each row execute function private.quiz_revoke_departed_progress();
create trigger quiz_revoke_unlinked_progress after delete on public.quiz_group_problem_sets for each row execute function private.quiz_revoke_departed_progress();

revoke all on function public.publish_problem_set_versioned(jsonb,jsonb), public.get_shared_problem_set_versioned(uuid,text), public.quiz_get_publication_version(uuid,uuid,text), public.quiz_group_progress_consent(uuid,uuid,boolean,text,uuid,uuid), public.quiz_group_progress_update(uuid,uuid,uuid,text,uuid,integer), public.quiz_group_progress_read(uuid,uuid) from public, anon, authenticated;
grant execute on function public.publish_problem_set_versioned(jsonb,jsonb), public.quiz_group_progress_consent(uuid,uuid,boolean,text,uuid,uuid), public.quiz_group_progress_update(uuid,uuid,uuid,text,uuid,integer), public.quiz_group_progress_read(uuid,uuid) to authenticated;
grant execute on function public.get_shared_problem_set_versioned(uuid,text), public.quiz_get_publication_version(uuid,uuid,text) to anon, authenticated;
