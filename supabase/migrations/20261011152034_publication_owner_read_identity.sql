-- Keep the authorized/versioned reader as the gate. Only the source owner
-- needs the device ID to bind a completed publication back to its local set.
create or replace function public.get_shared_problem_set_versioned(p_set_id uuid,p_share_token text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;source_identity jsonb;
begin
 result:=public.get_shared_problem_set(p_set_id,p_share_token);
 if result is null then return null;end if;
 select jsonb_build_object('local_set_id',s.local_set_id) into source_identity
 from public.shared_problem_sets s where s.id=p_set_id and s.owner_id=auth.uid();
 return result||coalesce(source_identity,'{}'::jsonb)
 ||jsonb_build_object('import_count',(select count(distinct actor_id) from public.problem_set_copies where set_id=p_set_id));
end $$;
revoke all on function public.get_shared_problem_set_versioned(uuid,text) from public;
grant execute on function public.get_shared_problem_set_versioned(uuid,text) to anon,authenticated;
