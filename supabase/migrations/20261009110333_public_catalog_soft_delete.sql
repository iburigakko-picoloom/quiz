-- Reversible deletion of public catalog destinations; source versions, copies and group sharing stay intact.
alter table private.quiz_public_folders add column deleted_at timestamptz;
alter table private.quiz_public_folder_sets add column deleted_at timestamptz;
create table private.quiz_public_deleted_sets (
 set_id uuid primary key references public.shared_problem_sets(id) on delete cascade,
 deleted_at timestamptz not null default now(),deleted_by_folder uuid references private.quiz_public_folders(id)
);
create index quiz_public_deleted_sets_folder_idx on private.quiz_public_deleted_sets(deleted_by_folder);
alter table private.quiz_public_deleted_sets enable row level security;
revoke all on private.quiz_public_deleted_sets from public,anon,authenticated;
-- Stop delayed old publishers at the write boundary as well as at catalog reads.
create function private.quiz_public_guard_deleted_set_public() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.visibility='public' and exists(select 1 from private.quiz_public_deleted_sets where set_id=new.id) then raise exception 'public set deleted; restore before publishing';end if;
 return new;
end $$;
revoke all on function private.quiz_public_guard_deleted_set_public() from public,anon,authenticated;
create trigger quiz_public_guard_deleted_set_public before update of visibility on public.shared_problem_sets for each row execute function private.quiz_public_guard_deleted_set_public();
create or replace function quiz_public_api.can_read(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.shared_problem_sets s where s.id=p_id and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=s.id) and (s.visibility='public' or exists(select 1 from private.quiz_public_folder_sets m join private.quiz_public_folders f on f.id=m.folder_id where m.set_id=s.id and m.deleted_at is null and f.published and f.deleted_at is null)))
$$;
create or replace function quiz_public_api.set_summary(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select (to_jsonb(s)-array['share_token','local_set_id','current_version_id','question_payload_bytes'])||jsonb_build_object('version_id',s.current_version_id,'standalone_public',s.visibility='public' and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=s.id),'import_count',(select count(distinct actor_id) from public.problem_set_copies where set_id=s.id),'public_catalog',quiz_public_api.can_read(s.id),'deleted_at',case when s.owner_id=auth.uid() then (select d.deleted_at from private.quiz_public_deleted_sets d where d.set_id=s.id) end,'tags',array_remove(array[s.subject,s.audience],'')) from public.shared_problem_sets s where s.id=p_id
$$;
create or replace function quiz_public_api.folder_summary(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select (to_jsonb(f)-array['pending_set_ids','local_folder_id'])||jsonb_build_object('author_name',coalesce(nullif(p.display_name,''),'Quiz Make ユーザー'),'set_count',(select count(*) from private.quiz_public_folder_sets where folder_id=f.id and deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=private.quiz_public_folder_sets.set_id)),'question_count',(select coalesce(sum(s.question_count),0) from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=f.id and m.deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=m.set_id)),'import_count',(select count(distinct cp.actor_id) from private.quiz_public_folder_sets m join public.problem_set_copies cp on cp.set_id=m.set_id where m.folder_id=f.id and m.deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=m.set_id))) from private.quiz_public_folders f left join public.quiz_profiles p on p.user_id=f.owner_id where f.id=p_id
$$;
create or replace function quiz_public_api.search(p_query text,p_kind text,p_category text,p_min integer,p_max integer,p_sort text,p_offset integer,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare folders jsonb;sets jsonb;categories jsonb;limit_value integer:=least(greatest(coalesce(p_limit,30),1),60);offset_value integer:=greatest(coalesce(p_offset,0),0);
begin
 if coalesce(p_kind,'all') not in ('all','folder','set') or coalesce(p_sort,'popular') not in ('popular','new','updated') or coalesce(p_min,0)<0 or p_max is not null and p_max<p_min or char_length(coalesce(p_query,''))>200 then raise exception 'invalid search';end if;
 with candidates as (select quiz_public_api.folder_summary(id) item from private.quiz_public_folders where published and deleted_at is null),filtered as (
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
 select category from private.quiz_public_folders where published and deleted_at is null and category<>'' union select s.subject from public.shared_problem_sets s where quiz_public_api.can_read(s.id) and s.subject<>'' union select s.audience from public.shared_problem_sets s where quiz_public_api.can_read(s.id) and s.audience<>'' ) c;
 return jsonb_build_object('folders',case when p_kind='set' then '[]'::jsonb else folders end,'sets',case when p_kind='folder' then '[]'::jsonb else sets end,'categories',categories);
end $$;
create or replace function quiz_public_api.folder_read(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from private.quiz_public_folders where id=p_id and ((published and deleted_at is null) or owner_id=auth.uid())) then raise exception 'not authorized';end if;
 return quiz_public_api.folder_summary(p_id)||case when exists(select 1 from private.quiz_public_folders where id=p_id and owner_id=auth.uid()) then jsonb_build_object('retained_set_count',(select count(*) from private.quiz_public_folder_sets m where m.folder_id=p_id and m.deleted_at is null and exists(select 1 from private.quiz_public_folder_sets om join private.quiz_public_folders of2 on of2.id=om.folder_id where om.set_id=m.set_id and om.folder_id<>p_id and om.deleted_at is null and of2.published and of2.deleted_at is null)),'standalone_set_count',(select count(*) from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=p_id and m.deleted_at is null and s.visibility='public' and not exists(select 1 from private.quiz_public_folder_sets om join private.quiz_public_folders of2 on of2.id=om.folder_id where om.set_id=m.set_id and om.folder_id<>p_id and om.deleted_at is null and of2.published and of2.deleted_at is null))) else '{}'::jsonb end||case when exists(select 1 from private.quiz_public_folders where id=p_id and owner_id=auth.uid()) then jsonb_build_object('local_folder_id',(select local_folder_id from private.quiz_public_folders where id=p_id)) else '{}'::jsonb end||jsonb_build_object('members',(select coalesce(jsonb_agg(quiz_public_api.set_summary(m.set_id)||jsonb_build_object('member_path',m.folder_path) order by s.updated_at desc,s.id),'[]') from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=p_id and m.deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=m.set_id)));
end $$;
create or replace function quiz_public_api.mine() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'not authorized';end if;
 return jsonb_build_object('folders',(select coalesce(jsonb_agg(quiz_public_api.folder_summary(id)||jsonb_build_object('local_folder_id',local_folder_id) order by updated_at desc),'[]') from private.quiz_public_folders where owner_id=auth.uid()),'sets',(select coalesce(jsonb_agg(quiz_public_api.set_summary(id)||jsonb_build_object('local_set_id',local_set_id) order by updated_at desc),'[]') from public.shared_problem_sets where owner_id=auth.uid()));
end $$;
create or replace function quiz_public_api.folder_manage(p_action text,p_id uuid,p_meta jsonb,p_set_id uuid,p_path jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();target uuid;f private.quiz_public_folders;tag text;target_set public.shared_problem_sets;ids jsonb;
begin
 if actor is null then raise exception 'not authorized';end if;
 -- Serialize public destination changes for one owner without blocking other accounts.
 perform pg_advisory_xact_lock(hashtextextended(actor::text,621));
 if p_action in ('delete_set','restore_set') then
   select * into target_set from public.shared_problem_sets where id=p_id and owner_id=actor for update;
   if not found then raise exception 'not authorized';end if;
   if p_action='delete_set' then
     if exists(select 1 from private.quiz_public_deleted_sets where set_id=target_set.id) then return target_set.id;end if;
     if p_meta->>'expected_updated_at' is null or (p_meta->>'expected_updated_at')::timestamptz is distinct from target_set.updated_at then raise exception 'publication changed; reload before deleting';end if;
     insert into private.quiz_public_deleted_sets(set_id) values(target_set.id);
     update private.quiz_public_folder_sets set deleted_at=now() where set_id=target_set.id and deleted_at is null;
     update private.quiz_public_folders f2 set updated_at=now() where exists(select 1 from private.quiz_public_folder_sets m where m.folder_id=f2.id and m.set_id=target_set.id);
   else
     if not exists(select 1 from private.quiz_public_deleted_sets where set_id=target_set.id) then return target_set.id;end if;
     if p_meta->>'expected_deleted_at' is null or not exists(select 1 from private.quiz_public_deleted_sets where set_id=target_set.id and deleted_at=(p_meta->>'expected_deleted_at')::timestamptz) then raise exception 'publication changed; reload before restoring';end if;
     delete from private.quiz_public_deleted_sets where set_id=target_set.id;
   end if;
   update public.shared_problem_sets set visibility=case when exists(select 1 from public.quiz_group_problem_sets where set_id=target_set.id) then 'group' else 'link' end,updated_at=now() where id=target_set.id;
   return target_set.id;
 end if;
 if p_action='save' then
   if exists(select 1 from private.quiz_public_folders where owner_id=actor and local_folder_id=p_meta->>'local_folder_id' and deleted_at is not null) then raise exception 'public folder deleted; restore before publishing';end if;
   if char_length(trim(coalesce(p_meta->>'name',''))) not between 1 and 100 or char_length(coalesce(p_meta->>'local_folder_id','')) not between 1 and 200 or char_length(coalesce(p_meta->>'description',''))>1000 or jsonb_typeof(coalesce(p_meta->'tags','[]'))<>'array' or jsonb_array_length(coalesce(p_meta->'tags','[]'))>10 or jsonb_array_length(coalesce(p_meta->'pending_set_ids','[]'))>500 then raise exception 'invalid folder';end if;
   for tag in select value from jsonb_array_elements_text(coalesce(p_meta->'tags','[]')) loop if char_length(tag) not between 1 and 40 then raise exception 'invalid tag';end if;end loop;
   if p_id is not null and not exists(select 1 from private.quiz_public_folders where id=p_id and owner_id=actor) then raise exception 'not authorized';end if;
   insert into private.quiz_public_folders(owner_id,local_folder_id,name,description,category,tags,pending_set_ids)
   values(actor,p_meta->>'local_folder_id',trim(p_meta->>'name'),coalesce(p_meta->>'description',''),left(coalesce(p_meta->>'category',''),80),array(select jsonb_array_elements_text(coalesce(p_meta->'tags','[]'))),array(select jsonb_array_elements_text(coalesce(p_meta->'pending_set_ids','[]'))))
   on conflict(owner_id,local_folder_id) do update set name=excluded.name,description=excluded.description,category=excluded.category,tags=excluded.tags,pending_set_ids=case when p_meta?'pending_set_ids' then excluded.pending_set_ids else private.quiz_public_folders.pending_set_ids end,updated_at=now() returning id into target;return target;
 end if;
 select * into f from private.quiz_public_folders where id=p_id and owner_id=actor for update;if not found then raise exception 'not authorized';end if;
 if p_action='delete' then
   if f.deleted_at is not null then return f.id;end if;
   select coalesce(jsonb_agg(m.set_id::text order by m.set_id),'[]') into ids from private.quiz_public_folder_sets m where m.folder_id=f.id and m.deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=m.set_id);
   if p_meta->>'expected_updated_at' is null or (p_meta->>'expected_updated_at')::timestamptz is distinct from f.updated_at or p_meta->'expected_set_ids' is distinct from ids then raise exception 'publication changed; reload before deleting';end if;
   -- Other live public folders retain their sets. Standalone publications are retained unless explicitly included.
   if coalesce((p_meta->>'include_standalone')::boolean,false) then
     insert into private.quiz_public_deleted_sets(set_id,deleted_by_folder)
       select s.id,f.id from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id
       where m.folder_id=f.id and m.deleted_at is null and s.owner_id=actor
       and not exists(select 1 from private.quiz_public_folder_sets other_m join private.quiz_public_folders other_f on other_f.id=other_m.folder_id where other_m.set_id=s.id and other_m.folder_id<>f.id and other_m.deleted_at is null and other_f.published and other_f.deleted_at is null)
       on conflict do nothing;
     update public.shared_problem_sets s2 set visibility=case when exists(select 1 from public.quiz_group_problem_sets where set_id=s2.id) then 'group' else 'link' end,updated_at=now() where exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=s2.id and d.deleted_by_folder=f.id);
   end if;
   update private.quiz_public_folders set published=false,deleted_at=now(),pending_set_ids='{}',updated_at=now() where id=f.id;
   return f.id;
 elsif p_action='restore' then
   if f.deleted_at is null then return f.id;end if;
   if p_meta->>'expected_deleted_at' is null or (p_meta->>'expected_deleted_at')::timestamptz is distinct from f.deleted_at then raise exception 'publication changed; reload before restoring';end if;
   update public.shared_problem_sets s2 set visibility=case when exists(select 1 from public.quiz_group_problem_sets where set_id=s2.id) then 'group' else 'link' end,updated_at=now() where exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=s2.id and d.deleted_by_folder=f.id);
   -- Restoring never grants public access. Re-publication is a separate explicit action.
   delete from private.quiz_public_deleted_sets where deleted_by_folder=f.id;
   update private.quiz_public_folders set published=false,deleted_at=null,pending_set_ids='{}',updated_at=now() where id=f.id;
   return f.id;
 end if;
 if f.deleted_at is not null then raise exception 'public folder deleted; restore before publishing';end if;
 if p_action='add' then
   if exists(select 1 from private.quiz_public_deleted_sets where set_id=p_set_id) then raise exception 'public set deleted; restore before publishing';end if;
   if not exists(select 1 from public.shared_problem_sets where id=p_set_id and owner_id=actor and (current_version_id is not null or question_count>0)) then raise exception 'not authorized';end if;
   if jsonb_typeof(p_path) is distinct from 'array' or jsonb_array_length(p_path)>1 or exists(select 1 from jsonb_array_elements(p_path) part where char_length(coalesce(part->>'id','')) not between 1 and 200 or char_length(coalesce(part->>'name','')) not between 1 and 100) then raise exception 'invalid path';end if;
   insert into private.quiz_public_folder_sets(folder_id,set_id,folder_path) values(f.id,p_set_id,p_path) on conflict(folder_id,set_id) do update set folder_path=excluded.folder_path,deleted_at=null;
 elsif p_action='remove' then update private.quiz_public_folder_sets set deleted_at=now() where folder_id=f.id and set_id=p_set_id;
 elsif p_action='unpublish' then update private.quiz_public_folders set published=false,pending_set_ids='{}' where id=f.id;
 elsif p_action='publish' then
   if not exists(select 1 from private.quiz_public_folder_sets where folder_id=f.id and deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=private.quiz_public_folder_sets.set_id)) then raise exception 'empty folder';end if;
   update private.quiz_public_folders set published=true,published_at=coalesce(published_at,now()) where id=f.id;
 elsif p_action='ready' then
   if cardinality(f.pending_set_ids)>0 and not exists(select 1 from unnest(f.pending_set_ids) local_id where not exists(select 1 from private.quiz_public_folder_sets m join public.shared_problem_sets s on s.id=m.set_id where m.folder_id=f.id and m.deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=s.id) and s.owner_id=actor and s.local_set_id=local_id)) and exists(select 1 from private.quiz_public_folder_sets where folder_id=f.id and deleted_at is null and not exists(select 1 from private.quiz_public_deleted_sets d where d.set_id=private.quiz_public_folder_sets.set_id)) then update private.quiz_public_folders set published=true,pending_set_ids='{}',published_at=coalesce(published_at,now()) where id=f.id;end if;
 else raise exception 'invalid action';end if;
 update private.quiz_public_folders set updated_at=now() where id=f.id;return f.id;
end $$;
create or replace function quiz_public_api.set_public(p_id uuid,p_public boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.shared_problem_sets;
begin
 if auth.uid() is null then raise exception 'not authorized';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,621));
 if exists(select 1 from private.quiz_public_deleted_sets where set_id=p_id) then raise exception 'public set deleted; restore before publishing';end if;
 update public.shared_problem_sets set visibility=case when p_public then 'public' when exists(select 1 from public.quiz_group_problem_sets where set_id=p_id) then 'group' else 'link' end,updated_at=now() where id=p_id and owner_id=auth.uid() returning * into s;
 if not found then raise exception 'not authorized';end if;
 return jsonb_build_object('id',s.id,'share_token',s.share_token,'version_id',s.current_version_id,'visibility',s.visibility);
end $$;
