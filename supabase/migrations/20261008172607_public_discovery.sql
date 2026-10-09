-- Independent folder publication. Keep all legacy sets, versions and copies.
-- Prerequisite: 20261008151820_resumable_publication, locally verified first.
create schema if not exists quiz_public_api;
revoke all on schema quiz_public_api from public;
grant usage on schema quiz_public_api to anon,authenticated;
create table private.quiz_public_folders (
  id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
  local_folder_id text not null,name text not null check(char_length(trim(name)) between 1 and 100),
  description text not null default '' check(char_length(description)<=1000),category text not null default '',tags text[] not null default '{}',
  published boolean not null default false,pending_set_ids text[] not null default '{}',
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),published_at timestamptz,
  unique(owner_id,local_folder_id)
);
create index quiz_public_folders_visible_idx on private.quiz_public_folders(updated_at,id) where published;
create table private.quiz_public_folder_sets (
  folder_id uuid not null references private.quiz_public_folders(id) on delete cascade,
  set_id uuid not null references public.shared_problem_sets(id) on delete cascade,
  folder_path jsonb not null default '[]',primary key(folder_id,set_id),check(jsonb_typeof(folder_path)='array' and jsonb_array_length(folder_path)<=1)
);
create index quiz_public_folder_sets_set_idx on private.quiz_public_folder_sets(set_id,folder_id);
alter table private.quiz_public_folders enable row level security;
alter table private.quiz_public_folder_sets enable row level security;
revoke all on private.quiz_public_folders,private.quiz_public_folder_sets from public,anon,authenticated;

-- Preserve existing public folder grouping. Individual visibility is unchanged.
insert into private.quiz_public_folders(owner_id,local_folder_id,name,published,published_at)
 select distinct on(owner_id,folder_path->0->>'id') owner_id,folder_path->0->>'id',left(folder_path->0->>'name',100),true,min(published_at) over(partition by owner_id,folder_path->0->>'id')
 from public.shared_problem_sets where visibility='public' and jsonb_array_length(folder_path)>0 order by owner_id,folder_path->0->>'id',updated_at desc;
insert into private.quiz_public_folder_sets(folder_id,set_id,folder_path)
 select f.id,s.id,case when jsonb_array_length(s.folder_path)>1 then jsonb_build_array(s.folder_path->1) else '[]'::jsonb end
 from public.shared_problem_sets s join private.quiz_public_folders f on f.owner_id=s.owner_id and f.local_folder_id=s.folder_path->0->>'id' where s.visibility='public';
update private.quiz_public_folders f set category=(select case when count(distinct nullif(s.subject,''))=1 then min(nullif(s.subject,'')) else '' end from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=f.id),tags=array(select distinct tag from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id cross join lateral unnest(array[s.subject,s.audience]) tag where m.folder_id=f.id and tag<>'' order by tag limit 10);

create function quiz_public_api.can_read(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.shared_problem_sets s where s.id=p_id and (s.visibility='public' or exists(select 1 from private.quiz_public_folder_sets m join private.quiz_public_folders f on f.id=m.folder_id where m.set_id=s.id and f.published)))
$$;
create function quiz_public_api.set_summary(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select (to_jsonb(s)-array['share_token','local_set_id','current_version_id','question_payload_bytes'])||jsonb_build_object('version_id',s.current_version_id,'standalone_public',s.visibility='public','import_count',(select count(distinct actor_id) from public.problem_set_copies where set_id=s.id),'tags',array_remove(array[s.subject,s.audience],'')) from public.shared_problem_sets s where s.id=p_id
$$;
create function quiz_public_api.folder_summary(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select (to_jsonb(f)-array['pending_set_ids','local_folder_id'])||jsonb_build_object('author_name',coalesce(nullif(p.display_name,''),'Quiz Make ユーザー'),'set_count',(select count(*) from private.quiz_public_folder_sets where folder_id=f.id),'question_count',(select coalesce(sum(s.question_count),0) from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=f.id),'import_count',(select count(distinct cp.actor_id) from private.quiz_public_folder_sets m join public.problem_set_copies cp on cp.set_id=m.set_id where m.folder_id=f.id)) from private.quiz_public_folders f left join public.quiz_profiles p on p.user_id=f.owner_id where f.id=p_id
$$;

create function quiz_public_api.search(p_query text,p_kind text,p_category text,p_min integer,p_max integer,p_sort text,p_offset integer,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare folders jsonb;sets jsonb;categories jsonb;limit_value integer:=least(greatest(coalesce(p_limit,30),1),60);offset_value integer:=greatest(coalesce(p_offset,0),0);
begin
 if coalesce(p_kind,'all') not in ('all','folder','set') or coalesce(p_sort,'popular') not in ('popular','new','updated') or coalesce(p_min,0)<0 or p_max is not null and p_max<p_min or char_length(coalesce(p_query,''))>200 then raise exception 'invalid search';end if;
 with candidates as (select quiz_public_api.folder_summary(id) item from private.quiz_public_folders where published),filtered as (
 select item from candidates where coalesce(p_category,'') in ('',item->>'category') and (item->>'question_count')::integer>=coalesce(p_min,0) and (p_max is null or (item->>'question_count')::integer<=p_max)
 and (coalesce(p_query,'')='' or strpos(lower(concat_ws(' ',item->>'name',item->>'description',item->>'category',item->>'author_name',item->>'tags')),lower(p_query))>0)
 order by case when p_sort='popular' then (item->>'import_count')::integer end desc,case when p_sort='new' then item->>'published_at' else item->>'updated_at' end desc,item->>'id' limit limit_value+1 offset offset_value)
 select coalesce(jsonb_agg(item),'[]') into folders from filtered;
 with candidates as (select quiz_public_api.set_summary(id) item from public.shared_problem_sets where quiz_public_api.can_read(id)),filtered as (
 select item from candidates where coalesce(p_category,'') in ('',item->>'subject',item->>'audience') and (item->>'question_count')::integer>=coalesce(p_min,0) and (p_max is null or (item->>'question_count')::integer<=p_max)
 and (coalesce(p_query,'')='' or strpos(lower(concat_ws(' ',item->>'title',item->>'description',item->>'subject',item->>'audience',item->>'author_name')),lower(p_query))>0)
 order by case when p_sort='popular' then (item->>'import_count')::integer end desc,case when p_sort='new' then item->>'published_at' else item->>'updated_at' end desc,item->>'id' limit limit_value+1 offset offset_value)
 select coalesce(jsonb_agg(item),'[]') into sets from filtered;
 select coalesce(jsonb_agg(category order by category),'[]') into categories from (
 select category from private.quiz_public_folders where published and category<>'' union select s.subject from public.shared_problem_sets s where quiz_public_api.can_read(s.id) and s.subject<>'' union select s.audience from public.shared_problem_sets s where quiz_public_api.can_read(s.id) and s.audience<>'' ) c;
 return jsonb_build_object('folders',case when p_kind='set' then '[]'::jsonb else folders end,'sets',case when p_kind='folder' then '[]'::jsonb else sets end,'categories',categories);
end $$;

create function quiz_public_api.folder_read(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from private.quiz_public_folders where id=p_id and (published or owner_id=auth.uid())) then raise exception 'not authorized';end if;
 return quiz_public_api.folder_summary(p_id)||case when exists(select 1 from private.quiz_public_folders where id=p_id and owner_id=auth.uid()) then jsonb_build_object('local_folder_id',(select local_folder_id from private.quiz_public_folders where id=p_id)) else '{}'::jsonb end||jsonb_build_object('members',(select coalesce(jsonb_agg(quiz_public_api.set_summary(m.set_id)||jsonb_build_object('member_path',m.folder_path) order by s.updated_at desc,s.id),'[]') from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=p_id));
end $$;
create function quiz_public_api.mine() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'not authorized';end if;
 return jsonb_build_object('folders',(select coalesce(jsonb_agg(quiz_public_api.folder_summary(id)||jsonb_build_object('local_folder_id',local_folder_id) order by updated_at desc),'[]') from private.quiz_public_folders where owner_id=auth.uid()),'sets',(select coalesce(jsonb_agg(quiz_public_api.set_summary(id)||jsonb_build_object('local_set_id',local_set_id) order by updated_at desc),'[]') from public.shared_problem_sets where owner_id=auth.uid()));
end $$;
create function quiz_public_api.folder_manage(p_action text,p_id uuid,p_meta jsonb,p_set_id uuid,p_path jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();target uuid;f private.quiz_public_folders;tag text;
begin
 if actor is null then raise exception 'not authorized';end if;
 if p_action='save' then
   if char_length(trim(coalesce(p_meta->>'name',''))) not between 1 and 100 or char_length(coalesce(p_meta->>'local_folder_id','')) not between 1 and 200 or char_length(coalesce(p_meta->>'description',''))>1000 or jsonb_typeof(coalesce(p_meta->'tags','[]'))<>'array' or jsonb_array_length(coalesce(p_meta->'tags','[]'))>10 or jsonb_array_length(coalesce(p_meta->'pending_set_ids','[]'))>500 then raise exception 'invalid folder';end if;
   for tag in select value from jsonb_array_elements_text(coalesce(p_meta->'tags','[]')) loop if char_length(tag) not between 1 and 40 then raise exception 'invalid tag';end if;end loop;
   if p_id is not null and not exists(select 1 from private.quiz_public_folders where id=p_id and owner_id=actor) then raise exception 'not authorized';end if;
   insert into private.quiz_public_folders(owner_id,local_folder_id,name,description,category,tags,pending_set_ids)
   values(actor,p_meta->>'local_folder_id',trim(p_meta->>'name'),coalesce(p_meta->>'description',''),left(coalesce(p_meta->>'category',''),80),array(select jsonb_array_elements_text(coalesce(p_meta->'tags','[]'))),array(select jsonb_array_elements_text(coalesce(p_meta->'pending_set_ids','[]'))))
   on conflict(owner_id,local_folder_id) do update set name=excluded.name,description=excluded.description,category=excluded.category,tags=excluded.tags,pending_set_ids=case when p_meta?'pending_set_ids' then excluded.pending_set_ids else private.quiz_public_folders.pending_set_ids end,updated_at=now() returning id into target;return target;
 end if;
 select * into f from private.quiz_public_folders where id=p_id and owner_id=actor for update;if not found then raise exception 'not authorized';end if;
 if p_action='add' then
   if not exists(select 1 from public.shared_problem_sets where id=p_set_id and owner_id=actor and (current_version_id is not null or question_count>0)) then raise exception 'not authorized';end if;
   if jsonb_typeof(p_path) is distinct from 'array' or jsonb_array_length(p_path)>1 or exists(select 1 from jsonb_array_elements(p_path) part where char_length(coalesce(part->>'id','')) not between 1 and 200 or char_length(coalesce(part->>'name','')) not between 1 and 100) then raise exception 'invalid path';end if;
   insert into private.quiz_public_folder_sets values(f.id,p_set_id,p_path) on conflict(folder_id,set_id) do update set folder_path=excluded.folder_path;
 elsif p_action='remove' then delete from private.quiz_public_folder_sets where folder_id=f.id and set_id=p_set_id;
 elsif p_action='unpublish' then update private.quiz_public_folders set published=false,pending_set_ids='{}' where id=f.id;
 elsif p_action='publish' then
   if not exists(select 1 from private.quiz_public_folder_sets where folder_id=f.id) then raise exception 'empty folder';end if;
   update private.quiz_public_folders set published=true,published_at=coalesce(published_at,now()) where id=f.id;
 elsif p_action='ready' then
   if cardinality(f.pending_set_ids)>0 and not exists(select 1 from unnest(f.pending_set_ids) local_id where not exists(select 1 from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=f.id and s.owner_id=actor and s.local_set_id=local_id)) and exists(select 1 from private.quiz_public_folder_sets where folder_id=f.id) then update private.quiz_public_folders set published=true,pending_set_ids='{}',published_at=coalesce(published_at,now()) where id=f.id;end if;
 else raise exception 'invalid action';end if;
 update private.quiz_public_folders set updated_at=now() where id=f.id;return f.id;
end $$;
create function quiz_public_api.set_public(p_id uuid,p_public boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.shared_problem_sets;
begin
 if auth.uid() is null then raise exception 'not authorized';end if;
 update public.shared_problem_sets set visibility=case when p_public then 'public' when exists(select 1 from public.quiz_group_problem_sets where set_id=p_id) then 'group' else 'link' end,updated_at=now() where id=p_id and owner_id=auth.uid() returning * into s;
 if not found then raise exception 'not authorized';end if;
 return jsonb_build_object('id',s.id,'share_token',s.share_token,'version_id',s.current_version_id,'visibility',s.visibility);
end $$;
create function quiz_public_api.record_import(p_id uuid,p_installation uuid,p_local_id text) returns void language plpgsql security definer set search_path='' as $$
declare inserted integer;
begin
 if auth.uid() is null or quiz_public_api.can_read(p_id) is not true then raise exception 'not authorized';end if;
 insert into public.problem_set_copies(set_id,actor_id,installation_id,local_set_id) values(p_id,auth.uid(),p_installation,left(p_local_id,200)) on conflict do nothing;
 get diagnostics inserted=row_count;if inserted>0 then update public.shared_problem_sets set add_count=add_count+1 where id=p_id;end if;
end $$;

-- Existing readers gain public-folder authorization; no progress is returned.
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

create function public.quiz_public_search(p_query text default '',p_kind text default 'all',p_category text default '',p_min integer default 0,p_max integer default null,p_sort text default 'popular',p_offset integer default 0,p_limit integer default 30) returns jsonb language sql stable security invoker set search_path='' as $$select quiz_public_api.search(p_query,p_kind,p_category,p_min,p_max,p_sort,p_offset,p_limit);$$;
create function public.quiz_public_folder(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select quiz_public_api.folder_read(p_id);$$;
create function public.quiz_public_mine() returns jsonb language sql stable security invoker set search_path='' as $$select quiz_public_api.mine();$$;
create function public.quiz_public_folder_manage(p_action text,p_id uuid default null,p_meta jsonb default '{}',p_set_id uuid default null,p_path jsonb default '[]') returns uuid language sql security invoker set search_path='' as $$select quiz_public_api.folder_manage(p_action,p_id,p_meta,p_set_id,p_path);$$;
create function public.quiz_public_set_visibility(p_id uuid,p_public boolean) returns jsonb language sql security invoker set search_path='' as $$select quiz_public_api.set_public(p_id,p_public);$$;
create function public.quiz_public_record_import(p_id uuid,p_installation uuid,p_local_id text) returns void language sql security invoker set search_path='' as $$select quiz_public_api.record_import(p_id,p_installation,p_local_id);$$;
revoke all on all functions in schema quiz_public_api from public,anon,authenticated;
grant execute on function quiz_public_api.search(text,text,text,integer,integer,text,integer,integer),quiz_public_api.folder_read(uuid) to anon,authenticated;
grant execute on function quiz_public_api.mine(),quiz_public_api.folder_manage(text,uuid,jsonb,uuid,jsonb),quiz_public_api.set_public(uuid,boolean),quiz_public_api.record_import(uuid,uuid,text) to authenticated;
revoke all on function public.quiz_public_search(text,text,text,integer,integer,text,integer,integer),public.quiz_public_folder(uuid),public.quiz_public_mine(),public.quiz_public_folder_manage(text,uuid,jsonb,uuid,jsonb),public.quiz_public_set_visibility(uuid,boolean),public.quiz_public_record_import(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.quiz_public_search(text,text,text,integer,integer,text,integer,integer),public.quiz_public_folder(uuid) to anon,authenticated;
grant execute on function public.quiz_public_mine(),public.quiz_public_folder_manage(text,uuid,jsonb,uuid,jsonb),public.quiz_public_set_visibility(uuid,boolean),public.quiz_public_record_import(uuid,uuid,text) to authenticated;
