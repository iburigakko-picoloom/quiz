-- Read one member's consented, current-publication progress for every group material.
-- No per-question data or private progress is returned; this function writes nothing.
create function quiz_private.group_member_material_progress(p_group_id uuid, p_member_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id)
    or p_member_id is null or not public.is_quiz_group_member(p_group_id,p_member_id)
  then raise exception 'not authorized'; end if;
  with rows as (
    select s.id as set_id,s.current_version_id,
      case when not coalesce(c.enabled,false) then 'not_shared'
        when c.version_id is distinct from s.current_version_id then 'update_pending'
        when a.user_id is null or a.level0 is null then 'reflection_pending'
        else 'shared' end as state,
      a.answered,a.total,a.level0,a.level1,a.level2,a.level3,a.reflected_at
    from public.quiz_group_problem_sets gp
    join public.shared_problem_sets s on s.id=gp.set_id
    left join private.quiz_group_progress_consent c on c.group_id=gp.group_id and c.set_id=s.id and c.user_id=p_member_id
    left join private.quiz_group_progress_summaries a on a.group_id=c.group_id and a.set_id=c.set_id and a.user_id=c.user_id
      and a.generation=c.generation and a.version_id=c.version_id
    where gp.group_id=p_group_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('set_id',set_id,'version_id',current_version_id,'state',state,
    'answered',case when state='shared' then answered end,
    'total',case when state='shared' then total end,
    'levels',case when state='shared' then jsonb_build_array(level0,level1,level2,level3) end,
    'reflected_at',case when state='shared' then reflected_at end) order by set_id),'[]'::jsonb)
  into result from rows;
  return result;
end $$;
create function public.quiz_group_member_material_progress(p_group_id uuid,p_member_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select quiz_private.group_member_material_progress(p_group_id,p_member_id);
$$;
revoke all on function quiz_private.group_member_material_progress(uuid,uuid),public.quiz_group_member_material_progress(uuid,uuid) from public,anon;
grant execute on function quiz_private.group_member_material_progress(uuid,uuid),public.quiz_group_member_material_progress(uuid,uuid) to authenticated;
