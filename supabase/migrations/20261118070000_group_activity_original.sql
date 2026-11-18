create or replace function quiz_private.group_activity_publish(p_group_id uuid,p_generation uuid,p_event_id text,p_set_id uuid,p_version_id uuid,p_copy_id text,p_started_at timestamptz,p_finished_at timestamptz,p_answered integer)
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
  if not exists(select 1 from public.problem_set_copies where set_id=p_set_id and actor_id=auth.uid())
    and not exists(select 1 from public.shared_problem_sets where id=p_set_id and owner_id=auth.uid() and local_set_id=p_copy_id)
  then return false; end if;
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
