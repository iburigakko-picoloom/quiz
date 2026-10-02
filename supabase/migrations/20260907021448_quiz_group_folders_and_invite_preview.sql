-- Group organization changes references only, never the owner's content.
create schema if not exists quiz_private;
revoke all on schema quiz_private from public, anon;
grant usage on schema quiz_private to authenticated;

alter table public.quiz_groups add column accent text not null default 'blue'
  check (accent in ('blue','cyan','green','violet'));
create table public.quiz_group_folders (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.quiz_groups(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  parent_folder_id uuid,
  created_at timestamptz not null default now(),
  unique (group_id,id),
  check (id is distinct from parent_folder_id),
  foreign key (group_id,parent_folder_id) references public.quiz_group_folders(group_id,id) on delete cascade
);
create index quiz_group_folders_parent_idx on public.quiz_group_folders(group_id,parent_folder_id);
alter table public.quiz_group_folders enable row level security;
revoke all on public.quiz_group_folders from public, anon, authenticated;
grant select on public.quiz_group_folders to authenticated;
create policy group_folder_member_read on public.quiz_group_folders for select to authenticated
  using (public.is_quiz_group_member(group_id));

alter table public.quiz_group_problem_sets add column group_folder_id uuid;
alter table public.quiz_group_problem_sets add constraint quiz_group_placement_folder_fk
  foreign key (group_id,group_folder_id) references public.quiz_group_folders(group_id,id)
  on delete set null (group_folder_id);
create index quiz_group_placements_folder_idx on public.quiz_group_problem_sets(group_id,group_folder_id);

-- Privileged writes stay outside exposed schemas; wrappers are SECURITY INVOKER.
create function quiz_private.manage_group_library(p_group_id uuid, p_action text, p_id uuid, p_name text, p_parent_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid; parent_row public.quiz_group_folders%rowtype;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_groups where id=p_group_id for update;
  if not found or not public.is_quiz_group_admin(p_group_id) then raise exception 'not authorized'; end if;
  if p_action in ('create','update','place') and p_parent_id is not null then
    select * into parent_row from public.quiz_group_folders where group_id=p_group_id and id=p_parent_id;
    if not found then raise exception 'folder not found'; end if;
    if p_action <> 'place' and (parent_row.parent_folder_id is not null or p_parent_id=p_id) then raise exception 'invalid folder depth'; end if;
  end if;
  if p_action in ('create','update') then
    if p_name is null or char_length(trim(p_name)) not between 1 and 60 then raise exception 'invalid folder name'; end if;
    if p_action='create' then
      insert into public.quiz_group_folders(group_id,name,parent_folder_id) values(p_group_id,trim(p_name),p_parent_id) returning id into result_id;
    else
      if p_parent_id is not null and exists(select 1 from public.quiz_group_folders where group_id=p_group_id and parent_folder_id=p_id) then raise exception 'invalid folder depth'; end if;
      update public.quiz_group_folders set name=trim(p_name),parent_folder_id=p_parent_id where group_id=p_group_id and id=p_id returning id into result_id;
      if not found then raise exception 'folder not found'; end if;
    end if;
  elsif p_action='delete' then
    delete from public.quiz_group_folders where group_id=p_group_id and id=p_id returning id into result_id;
    if not found then raise exception 'folder not found'; end if;
  elsif p_action='place' then
    update public.quiz_group_problem_sets set group_folder_id=p_parent_id where group_id=p_group_id and set_id=p_id returning set_id into result_id;
    if not found then raise exception 'shared reference not found'; end if;
  elsif p_action='remove' then
    delete from public.quiz_group_problem_sets where group_id=p_group_id and set_id=p_id returning set_id into result_id;
    if not found then raise exception 'shared reference not found'; end if;
  else raise exception 'invalid action';
  end if;
  return result_id;
end; $$;
create function public.manage_quiz_group_library(p_group_id uuid,p_action text,p_id uuid default null,p_name text default null,p_parent_id uuid default null)
returns uuid language sql security invoker set search_path = '' as $$
  select quiz_private.manage_group_library(p_group_id,p_action,p_id,p_name,p_parent_id);
$$;

create function quiz_private.get_group_library(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_quiz_group_member(p_group_id) then raise exception 'not authorized'; end if;
  return jsonb_build_object(
    'folders',(select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at,f.id),'[]'::jsonb) from public.quiz_group_folders f where group_id=p_group_id),
    'placements',(select coalesce(jsonb_agg(jsonb_build_object('set_id',set_id,'group_folder_id',group_folder_id)),'[]'::jsonb) from public.quiz_group_problem_sets where group_id=p_group_id),
    'sets',public.list_group_problem_sets(p_group_id));
end; $$;
create function public.get_quiz_group_library(p_group_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$ select quiz_private.get_group_library(p_group_id); $$;

create function quiz_private.preview_invite(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare invitation public.quiz_group_invites%rowtype; group_row public.quiz_groups%rowtype;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into invitation from public.quiz_group_invites where code=upper(trim(p_code));
  if not found then return jsonb_build_object('status','not_found'); end if;
  if invitation.revoked_at is not null or invitation.use_count>=invitation.max_uses then return jsonb_build_object('status','invalid'); end if;
  if invitation.expires_at<=now() then return jsonb_build_object('status','expired'); end if;
  select * into group_row from public.quiz_groups where id=invitation.group_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  return jsonb_build_object('status','valid','invite_id',invitation.id,'group_id',group_row.id,'name',group_row.name,'accent',group_row.accent,
    'expires_at',invitation.expires_at,'joined',public.is_quiz_group_member(group_row.id),
    'member_count',(select count(*) from public.quiz_group_members where group_id=group_row.id),
    'set_count',(select count(*) from public.quiz_group_problem_sets where group_id=group_row.id));
end; $$;
create function public.preview_quiz_group_invite(p_code text)
returns jsonb language sql stable security invoker set search_path = '' as $$ select quiz_private.preview_invite(p_code); $$;

create function quiz_private.join_confirmed_group(p_code text,p_invite_id uuid,p_group_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_group_invites where id=p_invite_id and group_id=p_group_id and code=upper(trim(p_code)) for update;
  if not found then raise exception 'invalid invite'; end if;
  return public.join_quiz_group(p_code);
end; $$;
create function public.join_confirmed_quiz_group(p_code text,p_invite_id uuid,p_group_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select quiz_private.join_confirmed_group(p_code,p_invite_id,p_group_id); $$;

create function quiz_private.group_invite(p_group_id uuid,p_action text,p_invite_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare invitation public.quiz_group_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  perform 1 from public.quiz_groups where id=p_group_id for update;
  if not found or not public.is_quiz_group_admin(p_group_id) then raise exception 'not authorized'; end if;
  if p_action='revoke' then
    update public.quiz_group_invites set revoked_at=coalesce(revoked_at,now()) where group_id=p_group_id and id=p_invite_id returning * into invitation;
    if not found then raise exception 'invalid invite'; end if;
    return jsonb_build_object('id',invitation.id,'revoked',true);
  end if;
  if p_action not in ('get','create') then raise exception 'invalid action'; end if;
  select * into invitation from public.quiz_group_invites where group_id=p_group_id and revoked_at is null and expires_at>now() and use_count<max_uses order by created_at desc limit 1;
  if not found then
    if p_action='get' then return null; end if;
    insert into public.quiz_group_invites(group_id,created_by) values(p_group_id,auth.uid()) returning * into invitation;
  end if;
  return jsonb_build_object('id',invitation.id,'code',invitation.code,'expires_at',invitation.expires_at);
end; $$;
create function public.manage_quiz_group_invite(p_group_id uuid,p_action text,p_invite_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select quiz_private.group_invite(p_group_id,p_action,p_invite_id); $$;
create or replace function public.create_group_invite(p_group_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select quiz_private.group_invite(p_group_id,'create',null); $$;

create function quiz_private.create_group(p_name text,p_accent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if p_accent is null or p_accent not in ('blue','cyan','green','violet') then raise exception 'invalid accent'; end if;
  result := public.create_quiz_group(p_name);
  update public.quiz_groups set accent=p_accent where id=(result->>'id')::uuid and owner_id=auth.uid();
  return result || jsonb_build_object('accent',p_accent);
end; $$;
create function public.create_quiz_group_with_accent(p_name text,p_accent text)
returns jsonb language sql security invoker set search_path = '' as $$ select quiz_private.create_group(p_name,p_accent); $$;

create or replace function public.list_my_groups()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'accent',g.accent,'role',m.role,
    'member_count',(select count(*) from public.quiz_group_members where group_id=g.id),
    'set_count',(select count(*) from public.quiz_group_problem_sets where group_id=g.id)) order by g.updated_at desc),'[]'::jsonb)
  from public.quiz_groups g join public.quiz_group_members m on m.group_id=g.id and m.user_id=auth.uid();
$$;

do $$ declare function_name text; begin
  foreach function_name in array array[
    'quiz_private.manage_group_library(uuid,text,uuid,text,uuid)', 'public.manage_quiz_group_library(uuid,text,uuid,text,uuid)',
    'quiz_private.get_group_library(uuid)', 'public.get_quiz_group_library(uuid)',
    'quiz_private.preview_invite(text)', 'public.preview_quiz_group_invite(text)',
    'quiz_private.join_confirmed_group(text,uuid,uuid)', 'public.join_confirmed_quiz_group(text,uuid,uuid)',
    'quiz_private.group_invite(uuid,text,uuid)', 'public.manage_quiz_group_invite(uuid,text,uuid)',
    'quiz_private.create_group(text,text)', 'public.create_quiz_group_with_accent(text,text)',
    'public.create_group_invite(uuid)', 'public.list_my_groups()'
  ] loop
    execute 'revoke all on function ' || function_name || ' from public, anon';
    execute 'grant execute on function ' || function_name || ' to authenticated';
  end loop;
end; $$;
