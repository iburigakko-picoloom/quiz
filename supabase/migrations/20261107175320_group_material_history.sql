-- Existing session events can be read for one current material without
-- treating unlinked manual records as progress or disclosing individual answers.
create function quiz_private.group_material_activity_history(p_group_id uuid,p_set_id uuid,p_version_id uuid,p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare entries jsonb;
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id)
    or not exists(select 1 from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_set_id)
  then raise exception 'not authorized'; end if;
  if not exists(select 1 from public.shared_problem_sets where id=p_set_id and current_version_id=p_version_id) then
    return jsonb_build_object('state','update_pending','entries','[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(row order by id desc),'[]'::jsonb) into entries from (
    select a.id,jsonb_build_object('id',a.id::text,'user_id',a.user_id,'display_name',coalesce(p.display_name,'メンバー'),'finished_at',a.finished_at,'answered',a.answered) row
    from private.quiz_group_activity a join private.quiz_group_activity_consent c using(group_id,user_id)
    join public.quiz_group_members m using(group_id,user_id)
    join public.quiz_group_problem_sets gp using(group_id,set_id)
    join public.shared_problem_sets s on s.id=a.set_id and s.current_version_id=a.version_id
    left join public.quiz_profiles p on p.user_id=a.user_id
    where a.group_id=p_group_id and a.set_id=p_set_id and a.version_id=p_version_id and c.enabled and c.generation=a.generation and not a.revoked and (p_before is null or a.id<p_before)
    order by a.id desc limit 50
  ) page;
  return jsonb_build_object('state','ready','entries',entries);
end $$;
create function public.quiz_group_material_activity_history(p_group_id uuid,p_set_id uuid,p_version_id uuid,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$ select quiz_private.group_material_activity_history(p_group_id,p_set_id,p_version_id,p_before); $$;
revoke all on function quiz_private.group_material_activity_history(uuid,uuid,uuid,bigint),public.quiz_group_material_activity_history(uuid,uuid,uuid,bigint) from public,anon;
grant execute on function quiz_private.group_material_activity_history(uuid,uuid,uuid,bigint),public.quiz_group_material_activity_history(uuid,uuid,uuid,bigint) to authenticated;
