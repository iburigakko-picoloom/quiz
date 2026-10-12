-- Group-only management: never edit or delete the published source or copies.
create function quiz_private.manage_group_folder(
  p_group_id uuid, p_action text, p_folder_id uuid, p_set_id uuid,
  p_owner_id uuid, p_path text[], p_name text, p_expected_set_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); administrator boolean; folder public.quiz_group_folders%rowtype;
  folder_ids uuid[]; set_ids uuid[]; expected_ids uuid[]; result_id uuid;
  source record; path_ids text[]; path_key text; folder_map jsonb := '{}'::jsonb;
  parent_id uuid; node_id uuid; depth integer;
begin
  if actor is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_groups where id=p_group_id for update;
  if not found or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  administrator := public.is_quiz_group_admin(p_group_id);
  if p_action is null or p_action not in ('rename','delete','remove_set') then raise exception 'invalid action'; end if;
  if p_action='remove_set' then
    perform 1 from public.quiz_group_problem_sets r join public.shared_problem_sets s on s.id=r.set_id
      where r.group_id=p_group_id and r.set_id=p_set_id and (administrator or s.owner_id=actor);
    if not found then raise exception 'not authorized'; end if;
    delete from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_set_id;
    return jsonb_build_object('removed_set_ids',jsonb_build_array(p_set_id));
  end if;
  if p_action='rename' and (p_name is null or char_length(trim(p_name)) not between 1 and 60) then raise exception 'invalid folder name'; end if;
  if p_folder_id is not null then
    select * into folder from public.quiz_group_folders where group_id=p_group_id and id=p_folder_id;
    if not found then raise exception 'folder changed'; end if;
    if not administrator and folder.created_by is distinct from actor then raise exception 'not authorized'; end if;
    result_id := folder.id;
    if p_action='rename' then
      update public.quiz_group_folders set name=trim(p_name),updated_at=now() where group_id=p_group_id and id=folder.id;
      return jsonb_build_object('folder_id',folder.id);
    end if;
    with recursive tree as (
      select id from public.quiz_group_folders where group_id=p_group_id and id=p_folder_id
      union all select f.id from public.quiz_group_folders f join tree t on f.parent_folder_id=t.id where f.group_id=p_group_id
    ) select array_agg(id) into folder_ids from tree;
    if not administrator and exists(select 1 from public.quiz_group_folders where id=any(folder_ids) and created_by is distinct from actor) then raise exception 'other contributions'; end if;
    select coalesce(array_agg(set_id order by set_id),'{}'::uuid[]) into set_ids
      from public.quiz_group_problem_sets where group_id=p_group_id and group_folder_id=any(folder_ids);
  else
    -- Older shares have only a source path. Resolve it on the server, scoped to
    -- this group and owner; IDs supplied by the client never define authority.
    if p_owner_id is null or coalesce(cardinality(p_path),0) not between 1 and 2 then raise exception 'folder changed'; end if;
    if not administrator and p_owner_id<>actor then raise exception 'not authorized'; end if;
    select coalesce(array_agg(s.id order by s.id),'{}'::uuid[]) into set_ids
      from public.quiz_group_problem_sets r join public.shared_problem_sets s on s.id=r.set_id
      where r.group_id=p_group_id and r.group_folder_id is null and s.owner_id=p_owner_id
        and (array(select part->>'id' from jsonb_array_elements(s.folder_path) part))[1:cardinality(p_path)]=p_path;
    if cardinality(set_ids)=0 then raise exception 'folder changed'; end if;
  end if;
  if p_expected_set_ids is null then raise exception 'folder changed'; end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into expected_ids from (select distinct unnest(p_expected_set_ids) id) expected;
  if expected_ids is distinct from set_ids then raise exception 'folder changed'; end if;
  if p_action='delete' then
    if not administrator and exists(select 1 from public.shared_problem_sets where id=any(set_ids) and owner_id is distinct from actor) then raise exception 'other contributions'; end if;
    delete from public.quiz_group_problem_sets where group_id=p_group_id and set_id=any(set_ids);
    if p_folder_id is not null then delete from public.quiz_group_folders where group_id=p_group_id and id=p_folder_id; end if;
    return jsonb_build_object('removed_set_ids',to_jsonb(set_ids));
  end if;
  -- Materialize the whole legacy root on rename, retaining sibling paths and
  -- creator identity. The source's public/other-group folder path is untouched.
  for source in select s.id,s.folder_path from public.quiz_group_problem_sets r join public.shared_problem_sets s on s.id=r.set_id
    where r.group_id=p_group_id and r.group_folder_id is null and s.owner_id=p_owner_id and s.folder_path->0->>'id'=p_path[1]
    order by s.id
  loop
    parent_id := null; path_ids := '{}';
    for depth in 0..jsonb_array_length(source.folder_path)-1 loop
      path_ids := array_append(path_ids,source.folder_path->depth->>'id');
      path_key := to_jsonb(path_ids)::text;
      node_id := (folder_map->>path_key)::uuid;
      if node_id is null then
        insert into public.quiz_group_folders(group_id,name,parent_folder_id,created_by)
          values(p_group_id,case when path_ids=p_path then trim(p_name) else source.folder_path->depth->>'name' end,parent_id,p_owner_id)
          returning id into node_id;
        folder_map := folder_map || jsonb_build_object(path_key,node_id);
      end if;
      if path_ids=p_path then result_id := node_id; end if;
      parent_id := node_id;
    end loop;
    update public.quiz_group_problem_sets set group_folder_id=parent_id where group_id=p_group_id and set_id=source.id;
  end loop;
  return jsonb_build_object('folder_id',result_id);
end; $$;

create function public.quiz_manage_group_folder(
  p_group_id uuid, p_action text, p_folder_id uuid default null, p_set_id uuid default null,
  p_owner_id uuid default null, p_path text[] default null, p_name text default null, p_expected_set_ids uuid[] default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_private.manage_group_folder(p_group_id,p_action,p_folder_id,p_set_id,p_owner_id,p_path,p_name,p_expected_set_ids);
$$;
revoke all on function quiz_private.manage_group_folder(uuid,text,uuid,uuid,uuid,text[],text,uuid[]) from public,anon;
revoke all on function public.quiz_manage_group_folder(uuid,text,uuid,uuid,uuid,text[],text,uuid[]) from public,anon;
grant execute on function quiz_private.manage_group_folder(uuid,text,uuid,uuid,uuid,text[],text,uuid[]) to authenticated;
grant execute on function public.quiz_manage_group_folder(uuid,text,uuid,uuid,uuid,text[],text,uuid[]) to authenticated;
