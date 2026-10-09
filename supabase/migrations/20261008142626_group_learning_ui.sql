-- Group UI metadata and opt-in learning aggregates. No answers are uploaded.
alter table public.quiz_groups add column icon text not null default 'group'
  check (icon in ('group','book','study','folder'));
alter table public.quiz_group_folders add column created_by uuid default auth.uid() references auth.users(id) on delete set null;
alter table public.quiz_group_folders add column updated_at timestamptz not null default now();
alter table private.quiz_group_progress_summaries
  add column level0 integer check (level0 >= 0),
  add column level1 integer check (level1 >= 0),
  add column level2 integer check (level2 >= 0),
  add column level3 integer check (level3 >= 0),
  add column today_count integer check (today_count >= 0),
  add column week_count integer check (week_count >= 0),
  add column activity_day date,
  add column activity_week_start date,
  add constraint quiz_learning_level_total check (
    (level0 is null and level1 is null and level2 is null and level3 is null)
    or (level0 is not null and level1 is not null and level2 is not null and level3 is not null
      and level0::bigint + level1 + level2 + level3 = total));
create index if not exists quiz_copy_set_actor_idx on public.problem_set_copies(set_id,actor_id);

-- Preserve existing folder paths as group-owned organization. Source paths stay intact.
do $$ declare placement record; part jsonb; folder_key text; folder_id uuid; parent_id uuid; mapped jsonb:='{}';
begin
  for placement in select gp.group_id,gp.set_id,s.owner_id,s.folder_path,s.updated_at
    from public.quiz_group_problem_sets gp join public.shared_problem_sets s on s.id=gp.set_id
    where gp.group_folder_id is null and jsonb_typeof(s.folder_path)='array'
  loop
    parent_id:=null;
    folder_key:=placement.group_id::text||'/'||placement.owner_id::text;
    for part in select value from jsonb_array_elements(placement.folder_path) with ordinality where ordinality<=2 loop
      folder_key:=folder_key||'/'||coalesce(part->>'id','');
      folder_id:=(mapped->>folder_key)::uuid;
      if folder_id is null then
        insert into public.quiz_group_folders(group_id,name,parent_folder_id,created_by,updated_at)
        values(placement.group_id,coalesce(nullif(left(trim(part->>'name'),60),''),'フォルダ'),parent_id,placement.owner_id,coalesce(placement.updated_at,now())) returning id into folder_id;
        mapped:=mapped||jsonb_build_object(folder_key,folder_id);
      end if;
      parent_id:=folder_id;
    end loop;
    if parent_id is not null then update public.quiz_group_problem_sets set group_folder_id=parent_id where group_id=placement.group_id and set_id=placement.set_id; end if;
  end loop;
end $$;

create or replace function public.get_shared_problem_set_versioned(p_set_id uuid,p_share_token text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; version uuid; manifest jsonb; import_count integer;
begin
  result:=public.get_shared_problem_set(p_set_id,p_share_token);
  select count(distinct actor_id) into import_count from public.problem_set_copies where set_id=p_set_id;
  result:=result||jsonb_build_object('import_count',import_count);
  select current_version_id into version from public.shared_problem_sets where id=p_set_id;
  if version is null then return result; end if;
  select questions into manifest from private.quiz_publication_versions where id=version and set_id=p_set_id;
  if manifest is null then raise exception 'publication version unavailable'; end if;
  return result||jsonb_build_object('version_id',version,'questions',manifest);
end $$;

-- A legacy client reflection must invalidate newer level/activity aggregates.
create function quiz_private.clear_learning_summary() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.reflected_at is distinct from old.reflected_at or new.generation is distinct from old.generation or new.version_id is distinct from old.version_id then
    new.level0:=null; new.level1:=null; new.level2:=null; new.level3:=null;
    new.today_count:=null; new.week_count:=null; new.activity_day:=null; new.activity_week_start:=null;
  end if;
  return new;
end $$;
revoke all on function quiz_private.clear_learning_summary() from public,anon,authenticated;
create trigger quiz_clear_learning_summary before update on private.quiz_group_progress_summaries
for each row execute function quiz_private.clear_learning_summary();

create function quiz_private.group_learning_update(p_group_id uuid,p_set_id uuid,p_generation uuid,p_copy_id text,p_version_id uuid,p_answered integer,p_levels integer[],p_today integer,p_week integer,p_day date,p_week_start date)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if p_levels is null or array_length(p_levels,1) is distinct from 4 or array_ndims(p_levels) is distinct from 1 or array_lower(p_levels,1) is distinct from 1
    or exists(select 1 from unnest(p_levels) n where n is null or n<0)
    or p_today is null or p_today<0 or p_week is null or p_week<p_today
    or p_day is distinct from (now() at time zone 'Asia/Tokyo')::date
    or p_week_start is distinct from date_trunc('week',now() at time zone 'Asia/Tokyo')::date
  then raise exception 'invalid learning aggregate'; end if;
  -- Existing locks, exact account, membership, publication, copy and consent checks.
  perform public.quiz_group_progress_update(p_group_id,p_set_id,p_generation,p_copy_id,p_version_id,p_answered);
  if (select sum(n::bigint) from unnest(p_levels) n) is distinct from
    (select total::bigint from private.quiz_group_progress_summaries where group_id=p_group_id and set_id=p_set_id and user_id=auth.uid())
  then raise exception 'invalid learning denominator'; end if;
  update private.quiz_group_progress_summaries set level0=p_levels[1],level1=p_levels[2],level2=p_levels[3],level3=p_levels[4],today_count=p_today,week_count=p_week,activity_day=p_day,activity_week_start=p_week_start
    where group_id=p_group_id and set_id=p_set_id and user_id=auth.uid();
  return true;
end $$;
create function public.quiz_group_learning_update(p_group_id uuid,p_set_id uuid,p_generation uuid,p_copy_id text,p_version_id uuid,p_answered integer,p_levels integer[],p_today integer,p_week integer,p_day date,p_week_start date)
returns boolean language sql security invoker set search_path = '' as $$
  select quiz_private.group_learning_update(p_group_id,p_set_id,p_generation,p_copy_id,p_version_id,p_answered,p_levels,p_today,p_week,p_day,p_week_start);
$$;

create function quiz_private.group_learning_set_read(p_group_id uuid,p_set_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; enriched jsonb;
begin
  result:=public.quiz_group_progress_read(p_group_id,p_set_id);
  select coalesce(jsonb_agg(member || jsonb_build_object('imported',member->>'state'<>'not_shared' or exists(select 1 from public.problem_set_copies cp where cp.set_id=p_set_id and cp.actor_id=(member->>'user_id')::uuid), 'levels',case when member->>'state'='shared' and a.level0 is not null then jsonb_build_array(a.level0,a.level1,a.level2,a.level3) end)),'[]'::jsonb)
  into enriched from jsonb_array_elements(result->'members') member
  left join private.quiz_group_progress_summaries a on a.group_id=p_group_id and a.set_id=p_set_id and a.user_id=(member->>'user_id')::uuid;
  return result || jsonb_build_object('members',enriched);
end $$;
create function public.quiz_group_learning_set_read(p_group_id uuid,p_set_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$ select quiz_private.group_learning_set_read(p_group_id,p_set_id); $$;

create function quiz_private.group_learning_read(p_group_id uuid,p_day date,p_week_start date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; folder_data jsonb; member_data jsonb;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  if p_day is distinct from (now() at time zone 'Asia/Tokyo')::date or p_week_start is distinct from date_trunc('week',now() at time zone 'Asia/Tokyo')::date then raise exception 'invalid learning period'; end if;
  with recursive folder_contents(root_id,id) as (
    select id,id from public.quiz_group_folders where group_id=p_group_id
    union all
    select fc.root_id,f.id from folder_contents fc join public.quiz_group_folders f on f.parent_folder_id=fc.id where f.group_id=p_group_id
  ), imports as (
    select fc.root_id,count(distinct c.actor_id) as count
    from folder_contents fc join public.quiz_group_problem_sets gp on gp.group_id=p_group_id and gp.group_folder_id=fc.id
    join public.problem_set_copies c on c.set_id=gp.set_id group by fc.root_id
  )
  select coalesce(jsonb_agg(to_jsonb(f)||jsonb_build_object('creator_name',coalesce(p.display_name,'作成者未記録'),'import_count',coalesce(i.count,0)) order by f.created_at,f.id),'[]'::jsonb)
    into folder_data from public.quiz_group_folders f left join public.quiz_profiles p on p.user_id=f.created_by left join imports i on i.root_id=f.id where f.group_id=p_group_id;

  with valid as (
    select a.* from private.quiz_group_progress_summaries a
    join private.quiz_group_progress_consent c using(group_id,set_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id,set_id)
    join public.shared_problem_sets s on s.id=a.set_id
    join public.quiz_group_members m on m.group_id=a.group_id and m.user_id=a.user_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation and c.version_id=a.version_id and a.version_id=s.current_version_id and a.level0 is not null
  ), aggregates as (
    select user_id,jsonb_build_array(sum(level0),sum(level1),sum(level2),sum(level3)) levels,count(*) shared_count,
      sum(today_count) filter(where activity_day=p_day) today_count,
      sum(week_count) filter(where activity_week_start=p_week_start) week_count
    from valid group by user_id
  ), copies as (
    select c.actor_id,count(distinct c.set_id) imported_count from public.problem_set_copies c
    join public.quiz_group_problem_sets gp on gp.set_id=c.set_id and gp.group_id=p_group_id group by c.actor_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',coalesce(p.display_name,'メンバー'),'role',m.role,
    'levels',a.levels,'shared_set_count',coalesce(a.shared_count,0),'today_count',a.today_count,'week_count',a.week_count,'imported_set_count',coalesce(cp.imported_count,0)) order by m.joined_at,m.user_id),'[]'::jsonb)
  into member_data from public.quiz_group_members m left join public.quiz_profiles p on p.user_id=m.user_id left join aggregates a on a.user_id=m.user_id left join copies cp on cp.actor_id=m.user_id where m.group_id=p_group_id;
  select jsonb_build_object('icon',g.icon,'accent',g.accent,'folders',folder_data,'members',member_data,
    'placements',(select coalesce(jsonb_agg(jsonb_build_object('set_id',gp.set_id,'group_folder_id',gp.group_folder_id)),'[]'::jsonb) from public.quiz_group_problem_sets gp where gp.group_id=p_group_id))
    into result from public.quiz_groups g where g.id=p_group_id;
  return result;
end $$;
create function public.quiz_group_learning_read(p_group_id uuid,p_day date,p_week_start date)
returns jsonb language sql stable security invoker set search_path = '' as $$ select quiz_private.group_learning_read(p_group_id,p_day,p_week_start); $$;

create function quiz_private.group_learning_icon(p_group_id uuid,p_icon text,p_accent text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_quiz_group_admin(p_group_id) then raise exception 'not authorized'; end if;
  if p_icon is null or p_icon not in ('group','book','study','folder') or p_accent is null or p_accent not in ('blue','cyan','green','violet') then raise exception 'invalid group icon'; end if;
  update public.quiz_groups set icon=p_icon,accent=p_accent,updated_at=now() where id=p_group_id;
  return true;
end $$;
create function public.quiz_group_learning_icon(p_group_id uuid,p_icon text,p_accent text)
returns boolean language sql security invoker set search_path = '' as $$ select quiz_private.group_learning_icon(p_group_id,p_icon,p_accent); $$;

-- Placement changes the group's reference, never the owner's published content.
create function quiz_private.group_learning_place(p_group_id uuid,p_set_id uuid,p_folder_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_groups where id=p_group_id for update;
  if not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  if not public.is_quiz_group_admin(p_group_id) and not exists(select 1 from public.shared_problem_sets where id=p_set_id and owner_id=auth.uid()) then raise exception 'not authorized'; end if;
  if p_folder_id is not null and not exists(select 1 from public.quiz_group_folders where group_id=p_group_id and id=p_folder_id) then raise exception 'folder not found'; end if;
  update public.quiz_group_problem_sets set group_folder_id=p_folder_id where group_id=p_group_id and set_id=p_set_id;
  if not found then raise exception 'shared reference not found'; end if;
  update public.quiz_group_folders set updated_at=now() where group_id=p_group_id and id=p_folder_id;
  return true;
end $$;
create function public.quiz_group_learning_place(p_group_id uuid,p_set_id uuid,p_folder_id uuid)
returns boolean language sql security invoker set search_path = '' as $$ select quiz_private.group_learning_place(p_group_id,p_set_id,p_folder_id); $$;

create or replace function public.list_my_groups()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'icon',g.icon,'accent',g.accent,'role',m.role,
    'member_count',(select count(*) from public.quiz_group_members where group_id=g.id),
    'set_count',(select count(*) from public.quiz_group_problem_sets where group_id=g.id)) order by g.updated_at desc),'[]'::jsonb)
  from public.quiz_groups g join public.quiz_group_members m on m.group_id=g.id and m.user_id=auth.uid();
$$;

do $$ declare signature text; begin
  foreach signature in array array[
    'group_learning_read(uuid,date,date)', 'group_learning_set_read(uuid,uuid)',
    'group_learning_update(uuid,uuid,uuid,text,uuid,integer,integer[],integer,integer,date,date)',
    'group_learning_icon(uuid,text,text)', 'group_learning_place(uuid,uuid,uuid)'
  ] loop
    execute 'revoke all on function quiz_private.' || signature || ' from public,anon';
    execute 'grant execute on function quiz_private.' || signature || ' to authenticated';
    execute 'revoke all on function public.quiz_' || signature || ' from public,anon';
    execute 'grant execute on function public.quiz_' || signature || ' to authenticated';
  end loop;
end $$;
