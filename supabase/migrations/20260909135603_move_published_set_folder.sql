-- Narrow owner-only operation: never changes questions, visibility or group membership.
create or replace function public.move_published_set_folder(p_set_id uuid, p_folder_path jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_folder_path is null or jsonb_typeof(p_folder_path) <> 'array' then raise exception 'Invalid folder path'; end if;
  if jsonb_array_length(p_folder_path) > 2 then raise exception 'Invalid folder depth'; end if;
  if exists (select 1 from jsonb_array_elements(p_folder_path) p where jsonb_typeof(p) <> 'object'
    or jsonb_typeof(p->'id') is distinct from 'string' or jsonb_typeof(p->'name') is distinct from 'string'
    or length(btrim(p->>'id')) not between 1 and 200 or length(btrim(p->>'name')) not between 1 and 200) then
    raise exception 'Invalid folder path';
  end if;
  update public.shared_problem_sets set folder_path = p_folder_path, updated_at = now()
    where id = p_set_id and owner_id = auth.uid();
  if not found then raise exception 'Published set not found or not owned'; end if;
end;
$$;
revoke all on function public.move_published_set_folder(uuid,jsonb) from public, anon;
grant execute on function public.move_published_set_folder(uuid,jsonb) to authenticated;
