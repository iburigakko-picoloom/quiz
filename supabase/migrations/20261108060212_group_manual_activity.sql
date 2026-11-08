-- Manual records are independent of published material progress.  They share
-- the existing monotonic timeline sequence so a cursor cannot collide.
create table private.quiz_group_manual_activity (
  id bigint primary key default nextval('private.quiz_group_activity_id_seq'::regclass),
  group_id uuid not null references public.quiz_groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  generation uuid not null,
  event_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  answered integer check (answered between 0 and 2000),
  minutes integer not null check (minutes between 1 and 1440),
  finished_at timestamptz not null,
  unique(group_id,user_id,event_id)
);
create index quiz_group_manual_activity_feed on private.quiz_group_manual_activity(group_id,id desc);
create index quiz_group_manual_activity_user on private.quiz_group_manual_activity(user_id);
alter table private.quiz_group_manual_activity enable row level security;
revoke all on private.quiz_group_manual_activity from public,anon,authenticated;

create function quiz_private.group_manual_activity_publish(p_group_id uuid,p_generation uuid,p_event_id uuid,p_title text,p_answered integer,p_minutes integer,p_finished_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $$
declare consent private.quiz_group_activity_consent; joined timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select joined_at into joined from public.quiz_group_members where group_id=p_group_id and user_id=auth.uid() for share;
  if not found then return false; end if;
  select * into consent from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid() for share;
  if not found or not consent.enabled or consent.generation is distinct from p_generation then return false; end if;
  if p_event_id is null or p_title is null or char_length(btrim(p_title)) not between 1 and 80
    or (p_answered is not null and p_answered not between 0 and 2000)
    or p_minutes is null or p_minutes not between 1 and 1440
    or p_finished_at is null or p_finished_at < greatest(joined,consent.enabled_at) or p_finished_at > now()+interval '5 minutes'
  then raise exception 'invalid activity'; end if;
  insert into private.quiz_group_manual_activity(group_id,user_id,generation,event_id,title,answered,minutes,finished_at)
    values(p_group_id,auth.uid(),p_generation,p_event_id,btrim(p_title),p_answered,p_minutes,p_finished_at)
    on conflict(group_id,user_id,event_id) do nothing;
  return true;
end $$;
create function public.quiz_group_manual_activity_publish(p_group_id uuid,p_generation uuid,p_event_id uuid,p_title text,p_answered integer,p_minutes integer,p_finished_at timestamptz)
returns boolean language sql security invoker set search_path='' as $$ select quiz_private.group_manual_activity_publish(p_group_id,p_generation,p_event_id,p_title,p_answered,p_minutes,p_finished_at); $$;

-- The original read RPC is retained for older clients. The v2 reader combines
-- both kinds without inventing a material ID or an elapsed time for sessions.
create function quiz_private.group_activity_read_v2(p_group_id uuid,p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare entries jsonb; own private.quiz_group_activity_consent;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  select * into own from private.quiz_group_activity_consent where group_id=p_group_id and user_id=auth.uid();
  select coalesce(jsonb_agg(row order by id desc),'[]'::jsonb) into entries from (
    select a.id,jsonb_build_object('id',a.id::text,'kind','session','user_id',a.user_id,'display_name',coalesce(p.display_name,'メンバー'),'set_id',a.set_id,'title',s.title,'finished_at',a.finished_at,'answered',a.answered,'minutes',null) row
    from private.quiz_group_activity a join private.quiz_group_activity_consent c using(group_id,user_id)
    join public.quiz_group_members m using(group_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id,set_id)
    join public.shared_problem_sets s on s.id=a.set_id and s.current_version_id=a.version_id
    left join public.quiz_profiles p on p.user_id=a.user_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation and not a.revoked and (p_before is null or a.id<p_before)
    union all
    select a.id,jsonb_build_object('id',a.id::text,'kind','manual','user_id',a.user_id,'display_name',coalesce(p.display_name,'メンバー'),'set_id',null,'title',a.title,'finished_at',a.finished_at,'answered',a.answered,'minutes',a.minutes) row
    from private.quiz_group_manual_activity a join private.quiz_group_activity_consent c using(group_id,user_id)
    join public.quiz_group_members m using(group_id,user_id)
    left join public.quiz_profiles p on p.user_id=a.user_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation and (p_before is null or a.id<p_before)
    order by id desc limit 50
  ) page;
  return jsonb_build_object('enabled',coalesce(own.enabled,false),'generation',own.generation,'entries',entries);
end $$;
create function public.quiz_group_activity_read_v2(p_group_id uuid,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$ select quiz_private.group_activity_read_v2(p_group_id,p_before); $$;
revoke all on function quiz_private.group_manual_activity_publish(uuid,uuid,uuid,text,integer,integer,timestamptz),public.quiz_group_manual_activity_publish(uuid,uuid,uuid,text,integer,integer,timestamptz),quiz_private.group_activity_read_v2(uuid,bigint),public.quiz_group_activity_read_v2(uuid,bigint) from public,anon;
grant execute on function quiz_private.group_manual_activity_publish(uuid,uuid,uuid,text,integer,integer,timestamptz),public.quiz_group_manual_activity_publish(uuid,uuid,uuid,text,integer,integer,timestamptz),quiz_private.group_activity_read_v2(uuid,bigint),public.quiz_group_activity_read_v2(uuid,bigint) to authenticated;
