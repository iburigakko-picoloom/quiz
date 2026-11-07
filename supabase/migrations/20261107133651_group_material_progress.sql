-- Additive read API. No stored questions, consent or progress are modified.
create function quiz_private.group_material_progress(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  with valid as (
    select a.* from private.quiz_group_progress_summaries a
    join private.quiz_group_progress_consent c using(group_id,set_id,user_id)
    join public.quiz_group_members m using(group_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id,set_id)
    join public.shared_problem_sets s on s.id=a.set_id
    where a.group_id=p_group_id and c.enabled and c.generation=a.generation
      and c.version_id=a.version_id and a.version_id=s.current_version_id and a.level0 is not null
  ), aggregates as (
    select set_id,count(*) learners,sum(answered) answered,sum(total) total,
      jsonb_build_array(sum(level0),sum(level1),sum(level2),sum(level3)) levels,
      max(reflected_at) reflected_at,
      case when count(today_count) filter(where activity_day=(now() at time zone 'Asia/Tokyo')::date)=count(*) then sum(today_count) end today_count,
      case when count(week_count) filter(where activity_week_start=date_trunc('week',now() at time zone 'Asia/Tokyo')::date)=count(*) then sum(week_count) end week_count
    from valid group by set_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('set_id',s.id,'version_id',s.current_version_id,
    'learners',coalesce(a.learners,0),'answered',a.answered,'total',a.total,'levels',a.levels,
    'reflected_at',a.reflected_at,'today_count',a.today_count,'week_count',a.week_count,
    'own_enabled',coalesce(c.enabled,false),'own_copy_id',c.copy_id,
    'own_state',case when not coalesce(c.enabled,false) then 'not_shared'
      when c.version_id is distinct from s.current_version_id then 'update_pending'
      when v.user_id is null then 'reflection_pending' else 'shared' end,
    'own_reflected_at',v.reflected_at) order by s.id),'[]'::jsonb)
  into result from public.quiz_group_problem_sets gp
  join public.shared_problem_sets s on s.id=gp.set_id
  left join aggregates a on a.set_id=s.id
  left join private.quiz_group_progress_consent c on c.group_id=gp.group_id and c.set_id=s.id and c.user_id=auth.uid()
  left join valid v on v.set_id=s.id and v.user_id=auth.uid()
  where gp.group_id=p_group_id;
  return result;
end $$;
create function public.quiz_group_material_progress(p_group_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select quiz_private.group_material_progress(p_group_id);
$$;
revoke all on function quiz_private.group_material_progress(uuid),public.quiz_group_material_progress(uuid) from public,anon;
grant execute on function quiz_private.group_material_progress(uuid),public.quiz_group_material_progress(uuid) to authenticated;
