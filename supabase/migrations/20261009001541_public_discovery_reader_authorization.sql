-- Reassert independent public-folder authorization after publication protocol rollout.
create or replace function public.get_shared_problem_set(p_set_id uuid,p_share_token text default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.shared_problem_sets;questions jsonb;allowed boolean;
begin
 select * into s from public.shared_problem_sets where id=p_set_id;if not found then return null;end if;
 allowed:=quiz_public_api.can_read(s.id) or s.owner_id=auth.uid() or (p_share_token is not null and p_share_token=s.share_token) or exists(select 1 from public.quiz_group_problem_sets gp where gp.set_id=s.id and public.is_quiz_group_member(gp.group_id));
 if allowed is not true then raise exception 'not authorized';end if;
 if s.current_version_id is not null then select v.questions into questions from private.quiz_publication_versions v where v.id=s.current_version_id and v.set_id=s.id;if questions is null then raise exception 'publication version unavailable';end if;
 else select coalesce(jsonb_agg(to_jsonb(q)-array['id','set_id','position','created_at','updated_at'] order by q.position),'[]') into questions from public.shared_questions q where q.set_id=s.id;end if;
 return (to_jsonb(s)-array['share_token','local_set_id','current_version_id','question_payload_bytes'])||jsonb_build_object('version_id',s.current_version_id,'questions',questions,'import_count',(select count(distinct actor_id) from public.problem_set_copies where set_id=s.id));
end $$;
