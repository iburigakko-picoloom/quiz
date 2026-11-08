-- Duration sharing has its own opt-in and generation. Old events retain NULL.
create table private.quiz_group_activity_time_consent (
  group_id uuid not null references public.quiz_groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  enabled boolean not null default false,
  generation uuid not null default gen_random_uuid(),
  enabled_at timestamptz not null default now(),
  primary key (group_id,user_id)
);
create index quiz_group_activity_time_consent_user on private.quiz_group_activity_time_consent(user_id);
alter table private.quiz_group_activity_time_consent enable row level security;
revoke all on private.quiz_group_activity_time_consent from public,anon,authenticated;
alter table private.quiz_group_activity add column elapsed_seconds integer check (elapsed_seconds between 1 and 604800), add column time_generation uuid,
  add constraint quiz_group_activity_duration_pair check ((elapsed_seconds is null) = (time_generation is null));

create function quiz_private.group_activity_time_consent(p_group_id uuid,p_enabled boolean,p_expected_generation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare old private.quiz_group_activity_time_consent; activity private.quiz_group_activity_consent;
begin
  if auth.uid() is null or p_enabled is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_group_members where group_id=p_group_id and user_id=auth.uid() for update;
  if not found then raise exception 'not authorized'; end if;
  select * into activity from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid() for share;
  if p_enabled and not coalesce(activity.enabled,false) then raise exception 'activity sharing disabled'; end if;
  select * into old from private.quiz_group_activity_time_consent where group_id=p_group_id and user_id=auth.uid() for update;
  if old.generation is distinct from p_expected_generation then raise exception 'consent changed'; end if;
  if old.enabled is not distinct from p_enabled then return true; end if;
  insert into private.quiz_group_activity_time_consent(group_id,user_id,enabled) values(p_group_id,auth.uid(),p_enabled)
    on conflict(group_id,user_id) do update set enabled=excluded.enabled,generation=gen_random_uuid(),enabled_at=now();
  return true;
end $$;
create function public.quiz_group_activity_time_consent(p_group_id uuid,p_enabled boolean,p_expected_generation uuid)
returns boolean language sql security invoker set search_path='' as $$ select quiz_private.group_activity_time_consent(p_group_id,p_enabled,p_expected_generation); $$;

create function quiz_private.revoke_group_activity_time() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='quiz_group_members' then
    update private.quiz_group_activity_time_consent set enabled=false,generation=gen_random_uuid(),enabled_at=now() where group_id=old.group_id and user_id=old.user_id;
  elsif not new.enabled then
    update private.quiz_group_activity_time_consent set enabled=false,generation=gen_random_uuid(),enabled_at=now() where group_id=old.group_id and user_id=old.user_id;
  end if;
  return null;
end $$;
revoke all on function quiz_private.revoke_group_activity_time() from public,anon,authenticated;
create trigger quiz_revoke_member_activity_time after delete on public.quiz_group_members for each row execute function quiz_private.revoke_group_activity_time();
create trigger quiz_revoke_activity_time after update of enabled on private.quiz_group_activity_consent for each row when (old.enabled and not new.enabled) execute function quiz_private.revoke_group_activity_time();

create function quiz_private.group_activity_destinations_v2(p_set_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('group_id',c.group_id,'generation',c.generation,'enabled_at',greatest(c.enabled_at,gp.shared_at,m.joined_at),
    'time_generation',case when t.enabled then t.generation else null end,
    'time_enabled_at',case when t.enabled then greatest(t.enabled_at,c.enabled_at,gp.shared_at,m.joined_at) else null end)),'[]'::jsonb)
    from private.quiz_group_activity_consent c join public.quiz_group_members m using(group_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id) left join private.quiz_group_activity_time_consent t using(group_id,user_id)
    where c.user_id=auth.uid() and c.enabled and gp.set_id=p_set_id);
end $$;
create function public.quiz_group_activity_destinations_v2(p_set_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$ select quiz_private.group_activity_destinations_v2(p_set_id); $$;

create function quiz_private.group_activity_publish_v2(p_group_id uuid,p_generation uuid,p_event_id text,p_set_id uuid,p_version_id uuid,p_copy_id text,p_started_at timestamptz,p_finished_at timestamptz,p_answered integer,p_time_generation uuid,p_time_started_at timestamptz,p_time_finished_at timestamptz,p_elapsed_seconds integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare accepted boolean; consent private.quiz_group_activity_time_consent;
begin
  if (p_elapsed_seconds is null and (p_time_generation is not null or p_time_started_at is not null or p_time_finished_at is not null)) or (p_elapsed_seconds is not null and (p_elapsed_seconds not between 1 and 604800 or p_time_generation is null or p_time_started_at is null or p_time_finished_at is null or p_time_started_at>p_time_finished_at or p_time_finished_at>now()+interval '5 minutes' or p_elapsed_seconds > ceil(extract(epoch from p_time_finished_at-p_time_started_at))+1)) then raise exception 'invalid duration'; end if;
  accepted := quiz_private.group_activity_publish(p_group_id,p_generation,p_event_id,p_set_id,p_version_id,p_copy_id,p_started_at,p_finished_at,p_answered);
  if not accepted then return false; end if;
  if p_elapsed_seconds is not null then
    select * into consent from private.quiz_group_activity_time_consent where group_id=p_group_id and user_id=auth.uid() for share;
    if consent.enabled and consent.generation=p_time_generation and exists(
      select 1 from public.quiz_group_members m join private.quiz_group_activity_consent c using(group_id,user_id)
      join public.quiz_group_problem_sets gp on gp.group_id=m.group_id and gp.set_id=p_set_id
      where m.group_id=p_group_id and m.user_id=auth.uid() and c.enabled and c.generation=p_generation
        and p_time_started_at>=greatest(consent.enabled_at,c.enabled_at,m.joined_at,gp.shared_at)
    ) then
      update private.quiz_group_activity a set elapsed_seconds=p_elapsed_seconds,time_generation=p_time_generation
        where a.group_id=p_group_id and a.user_id=auth.uid() and a.set_id=p_set_id and a.event_id=p_event_id and a.generation=p_generation and not a.revoked and a.time_generation is null;
    end if;
  end if;
  return true;
end $$;
create function public.quiz_group_activity_publish_v2(p_group_id uuid,p_generation uuid,p_event_id text,p_set_id uuid,p_version_id uuid,p_copy_id text,p_started_at timestamptz,p_finished_at timestamptz,p_answered integer,p_time_generation uuid,p_time_started_at timestamptz,p_time_finished_at timestamptz,p_elapsed_seconds integer)
returns boolean language sql security invoker set search_path='' as $$ select quiz_private.group_activity_publish_v2(p_group_id,p_generation,p_event_id,p_set_id,p_version_id,p_copy_id,p_started_at,p_finished_at,p_answered,p_time_generation,p_time_started_at,p_time_finished_at,p_elapsed_seconds); $$;

-- Preserve the v2 feed contract, adding nullable duration and the caller's consent.
create or replace function quiz_private.group_activity_read_v2(p_group_id uuid,p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare entries jsonb; own private.quiz_group_activity_consent; own_time private.quiz_group_activity_time_consent;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  select * into own from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid();
  select * into own_time from private.quiz_group_activity_time_consent where group_id=p_group_id and user_id=auth.uid();
  select coalesce(jsonb_agg(row order by id desc),'[]'::jsonb) into entries from (
    select a.id,jsonb_build_object('id',a.id::text,'kind','session','user_id',a.user_id,'display_name',coalesce(p.display_name,'メンバー'),'set_id',a.set_id,'title',s.title,'finished_at',a.finished_at,'answered',a.answered,'minutes',null,'seconds',case when t.enabled and t.generation=a.time_generation then a.elapsed_seconds else null end) row
    from private.quiz_group_activity a join private.quiz_group_activity_consent c using(group_id,user_id)
    join public.quiz_group_members m using(group_id,user_id) join public.quiz_group_problem_sets gp using(group_id,set_id)
    join public.shared_problem_sets s on s.id=a.set_id and s.current_version_id=a.version_id
    left join public.quiz_profiles p on p.user_id=a.user_id left join private.quiz_group_activity_time_consent t on t.group_id=a.group_id and t.user_id=a.user_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation and not a.revoked and (p_before is null or a.id<p_before)
    union all
    select a.id,jsonb_build_object('id',a.id::text,'kind','manual','user_id',a.user_id,'display_name',coalesce(p.display_name,'メンバー'),'set_id',null,'title',a.title,'finished_at',a.finished_at,'answered',a.answered,'minutes',a.minutes,'seconds',null) row
    from private.quiz_group_manual_activity a join private.quiz_group_activity_consent c using(group_id,user_id)
    join public.quiz_group_members m using(group_id,user_id) left join public.quiz_profiles p on p.user_id=a.user_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation and (p_before is null or a.id<p_before)
    order by id desc limit 50
  ) page;
  return jsonb_build_object('enabled',coalesce(own.enabled,false),'generation',own.generation,'time_enabled',coalesce(own_time.enabled,false),'time_generation',own_time.generation,'entries',entries);
end $$;

revoke all on function quiz_private.group_activity_time_consent(uuid,boolean,uuid),public.quiz_group_activity_time_consent(uuid,boolean,uuid),quiz_private.group_activity_destinations_v2(uuid),public.quiz_group_activity_destinations_v2(uuid),quiz_private.group_activity_publish_v2(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,integer,uuid,timestamptz,timestamptz,integer),public.quiz_group_activity_publish_v2(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,integer,uuid,timestamptz,timestamptz,integer) from public,anon;
grant execute on function quiz_private.group_activity_time_consent(uuid,boolean,uuid),public.quiz_group_activity_time_consent(uuid,boolean,uuid),quiz_private.group_activity_destinations_v2(uuid),public.quiz_group_activity_destinations_v2(uuid),quiz_private.group_activity_publish_v2(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,integer,uuid,timestamptz,timestamptz,integer),public.quiz_group_activity_publish_v2(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,integer,uuid,timestamptz,timestamptz,integer) to authenticated;
