-- Existing copy counts are per person, not per device. Admit current group
-- members as well as public readers; retain the existing deduplication key.
create function quiz_private.record_group_copy(p_set_id uuid,p_installation_id uuid,p_local_set_id text)
returns void language plpgsql security definer set search_path='' as $$
declare inserted_count integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not exists(select 1 from public.shared_problem_sets s where s.id=p_set_id and
    (s.visibility='public' or exists(select 1 from public.quiz_group_problem_sets gp
      where gp.set_id=s.id and public.is_quiz_group_member(gp.group_id)))) then raise exception 'set not found'; end if;
  insert into public.problem_set_copies(set_id,actor_id,installation_id,local_set_id)
    values(p_set_id,auth.uid(),p_installation_id,left(coalesce(p_local_set_id,''),200)) on conflict do nothing;
  get diagnostics inserted_count=row_count;
  if inserted_count>0 then update public.shared_problem_sets set add_count=add_count+1 where id=p_set_id; end if;
end $$;
create or replace function public.record_problem_set_copy(p_set_id uuid,p_installation_id uuid,p_local_set_id text default '')
returns void language sql security invoker set search_path='' as $$ select quiz_private.record_group_copy(p_set_id,p_installation_id,p_local_set_id); $$;
revoke all on function quiz_private.record_group_copy(uuid,uuid,text),public.record_problem_set_copy(uuid,uuid,text) from public,anon;
grant execute on function quiz_private.record_group_copy(uuid,uuid,text),public.record_problem_set_copy(uuid,uuid,text) to authenticated;

-- Activity consent is separate from cumulative learning progress consent.
create table private.quiz_group_activity_consent (
  group_id uuid not null references public.quiz_groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  enabled boolean not null default false,
  generation uuid not null default gen_random_uuid(),
  enabled_at timestamptz not null default now(),
  primary key(group_id,user_id)
);
create table private.quiz_group_activity (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.quiz_groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  set_id uuid not null references public.shared_problem_sets on delete cascade,
  version_id uuid not null,
  generation uuid not null,
  event_id text not null check(event_id ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  answered integer not null check(answered>0),
  revoked boolean not null default false,
  unique(group_id,user_id,set_id,event_id)
);
create index quiz_group_activity_user on private.quiz_group_activity(user_id);
create index quiz_group_activity_set on private.quiz_group_activity(set_id);
create index quiz_group_activity_consent_user on private.quiz_group_activity_consent(user_id);
create index quiz_group_activity_feed on private.quiz_group_activity(group_id,id desc) where not revoked;
alter table private.quiz_group_activity_consent enable row level security;
alter table private.quiz_group_activity enable row level security;
revoke all on private.quiz_group_activity_consent,private.quiz_group_activity from public,anon,authenticated;

create function quiz_private.group_activity_consent(p_group_id uuid,p_enabled boolean,p_expected_generation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare old private.quiz_group_activity_consent;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  if p_enabled is null then raise exception 'invalid consent'; end if;
  perform 1 from public.quiz_group_members where group_id=p_group_id and user_id=auth.uid() for update;
  if not found then raise exception 'not authorized'; end if;
  select * into old from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid() for update;
  if old.generation is distinct from p_expected_generation then raise exception 'consent changed'; end if;
  if old.enabled is not distinct from p_enabled then return true; end if;
  insert into private.quiz_group_activity_consent(group_id,user_id,enabled) values(p_group_id,auth.uid(),p_enabled)
  on conflict(group_id,user_id) do update set enabled=excluded.enabled,generation=gen_random_uuid(),enabled_at=now();
  return true;
end $$;
create function public.quiz_group_activity_consent(p_group_id uuid,p_enabled boolean,p_expected_generation uuid)
returns boolean language sql security invoker set search_path='' as $$ select quiz_private.group_activity_consent(p_group_id,p_enabled,p_expected_generation); $$;

create function quiz_private.group_activity_destinations(p_set_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('group_id',c.group_id,'generation',c.generation,'enabled_at',greatest(c.enabled_at,gp.shared_at,m.joined_at))),'[]'::jsonb)
    from private.quiz_group_activity_consent c join public.quiz_group_members m using(group_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id)
    where c.user_id=auth.uid() and c.enabled and gp.set_id=p_set_id);
end $$;
create function public.quiz_group_activity_destinations(p_set_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$ select quiz_private.group_activity_destinations(p_set_id); $$;

create function quiz_private.group_activity_publish(p_group_id uuid,p_generation uuid,p_event_id text,p_set_id uuid,p_version_id uuid,p_copy_id text,p_started_at timestamptz,p_finished_at timestamptz,p_answered integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare consent private.quiz_group_activity_consent; total integer; joined timestamptz; shared timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  -- Lock relations so leaving/unlinking cannot race a late publication.
  select joined_at into joined from public.quiz_group_members where group_id=p_group_id and user_id=auth.uid() for share;
  if not found then return false; end if;
  select shared_at into shared from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_set_id for share;
  if not found then return false; end if;
  select * into consent from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid() for share;
  if not coalesce(consent.enabled,false) or consent.generation is distinct from p_generation then return false; end if;
  if p_started_at < greatest(consent.enabled_at,joined,shared) then return false; end if;
  if not exists(select 1 from public.problem_set_copies where set_id=p_set_id and actor_id=auth.uid()) then return false; end if;
  select jsonb_array_length(v.questions) into total from public.shared_problem_sets s join private.quiz_publication_versions v on v.id=s.current_version_id and v.set_id=s.id
    where s.id=p_set_id and s.current_version_id=p_version_id;
  if total is null then return false; end if;
  if p_event_id is null or p_event_id !~ '^[a-f0-9]{64}$' or p_answered is null or p_answered<1 or p_answered>total
    or p_started_at is null or p_finished_at is null or p_started_at>p_finished_at or p_finished_at>now()+interval '5 minutes'
    then raise exception 'invalid activity'; end if;
  insert into private.quiz_group_activity(group_id,user_id,set_id,version_id,generation,event_id,started_at,finished_at,answered)
    values(p_group_id,auth.uid(),p_set_id,p_version_id,p_generation,p_event_id,p_started_at,p_finished_at,p_answered)
    on conflict(group_id,user_id,set_id,event_id) do nothing;
  return true;
end $$;
create function public.quiz_group_activity_publish(p_group_id uuid,p_generation uuid,p_event_id text,p_set_id uuid,p_version_id uuid,p_copy_id text,p_started_at timestamptz,p_finished_at timestamptz,p_answered integer)
returns boolean language sql security invoker set search_path='' as $$ select quiz_private.group_activity_publish(p_group_id,p_generation,p_event_id,p_set_id,p_version_id,p_copy_id,p_started_at,p_finished_at,p_answered); $$;

create function quiz_private.group_activity_read(p_group_id uuid,p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare entries jsonb; own private.quiz_group_activity_consent;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  select * into own from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid();
  select coalesce(jsonb_agg(row order by (row->>'id')::bigint desc),'[]'::jsonb) into entries from (
    select jsonb_build_object('id',a.id::text,'user_id',a.user_id,'display_name',coalesce(p.display_name,'メンバー'),'set_id',a.set_id,'title',s.title,'finished_at',a.finished_at,'answered',a.answered) row
    from private.quiz_group_activity a
    join private.quiz_group_activity_consent c using(group_id,user_id)
    join public.quiz_group_members m using(group_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id,set_id)
    join public.shared_problem_sets s on s.id=a.set_id and s.current_version_id=a.version_id
    left join public.quiz_profiles p on p.user_id=a.user_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation and not a.revoked and (p_before is null or a.id<p_before)
    order by a.id desc limit 50
  ) page;
  return jsonb_build_object('enabled',coalesce(own.enabled,false),'generation',own.generation,'entries',entries);
end $$;
create function public.quiz_group_activity_read(p_group_id uuid,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$ select quiz_private.group_activity_read(p_group_id,p_before); $$;

create function quiz_private.revoke_group_activity() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='quiz_group_members' then
    update private.quiz_group_activity_consent set enabled=false,generation=gen_random_uuid(),enabled_at=now() where group_id=old.group_id and user_id=old.user_id;
    update private.quiz_group_activity set revoked=true where group_id=old.group_id and user_id=old.user_id;
  else
    update private.quiz_group_activity set revoked=true where group_id=old.group_id and set_id=old.set_id;
  end if;
  return null;
end $$;
revoke all on function quiz_private.revoke_group_activity() from public,anon,authenticated;
create trigger quiz_revoke_member_activity after delete on public.quiz_group_members for each row execute function quiz_private.revoke_group_activity();
create trigger quiz_revoke_set_activity after delete on public.quiz_group_problem_sets for each row execute function quiz_private.revoke_group_activity();
do $$ declare signature text; begin
  foreach signature in array array['group_activity_consent(uuid,boolean,uuid)','group_activity_destinations(uuid)','group_activity_publish(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,integer)','group_activity_read(uuid,bigint)'] loop
    execute 'revoke all on function quiz_private.'||signature||' from public,anon';
    execute 'grant execute on function quiz_private.'||signature||' to authenticated';
    execute 'revoke all on function public.quiz_'||signature||' from public,anon';
    execute 'grant execute on function public.quiz_'||signature||' to authenticated';
  end loop;
end $$;
