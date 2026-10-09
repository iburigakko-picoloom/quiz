-- Distinct imported copies plus owned sources, only in this live group.
create or replace function quiz_private.group_learning_read(p_group_id uuid,p_day date,p_week_start date)
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
    select owned.actor_id,count(*) imported_count from (
      select c.actor_id,c.set_id from public.problem_set_copies c
      join public.quiz_group_problem_sets gp on gp.set_id=c.set_id and gp.group_id=p_group_id
      union
      select s.owner_id,s.id from public.shared_problem_sets s
      join public.quiz_group_problem_sets gp on gp.set_id=s.id and gp.group_id=p_group_id
    ) owned group by owned.actor_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',coalesce(p.display_name,'メンバー'),'role',m.role,
    'levels',a.levels,'shared_set_count',coalesce(a.shared_count,0),'today_count',a.today_count,'week_count',a.week_count,'imported_set_count',coalesce(cp.imported_count,0)) order by m.joined_at,m.user_id),'[]'::jsonb)
  into member_data from public.quiz_group_members m left join public.quiz_profiles p on p.user_id=m.user_id left join aggregates a on a.user_id=m.user_id left join copies cp on cp.actor_id=m.user_id where m.group_id=p_group_id;
  select jsonb_build_object('icon',g.icon,'accent',g.accent,'folders',folder_data,'members',member_data,
    'placements',(select coalesce(jsonb_agg(jsonb_build_object('set_id',gp.set_id,'group_folder_id',gp.group_folder_id)),'[]'::jsonb) from public.quiz_group_problem_sets gp where gp.group_id=p_group_id))
    into result from public.quiz_groups g where g.id=p_group_id;
  return result;
end $$;
