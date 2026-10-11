-- Publication PDFs are separate from owner-only synchronization PDFs.
-- Existing questions, versions, learning records and storage objects are retained.
alter table private.quiz_publication_versions add column materials jsonb not null default '[]'::jsonb check(jsonb_typeof(materials)='array');
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('quiz-publication-pdfs','quiz-publication-pdfs',false,52428800,array['application/pdf']) on conflict(id) do nothing;
create table private.quiz_publication_pdf_grants(user_id uuid not null references auth.users(id) on delete cascade,set_id uuid not null references public.shared_problem_sets(id) on delete cascade,version_id uuid not null,path text not null,token_hash text not null,expires_at timestamptz not null,primary key(user_id,set_id,path));
alter table private.quiz_publication_pdf_grants enable row level security;
revoke all on private.quiz_publication_pdf_grants from public,anon,authenticated;
create index quiz_publication_pdf_grant_path on private.quiz_publication_pdf_grants(path,user_id);

create function quiz_private.publication_materials(value jsonb,actor uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare m jsonb;p jsonb;pdf jsonb;result jsonb:='[]';pages jsonb;
begin
 if actor is null or jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value)>100 or octet_length(value::text)>1048576 then raise exception 'publication_invalid_materials';end if;
 for m in select * from jsonb_array_elements(value) loop
  if jsonb_typeof(m) is distinct from 'object' or char_length(coalesce(m->>'id','')) not between 1 and 200 or char_length(coalesce(m->>'title',''))>500 or jsonb_typeof(m->'pages') is distinct from 'array' or jsonb_array_length(m->'pages')>500 then raise exception 'publication_invalid_materials';end if;
  pages:='[]';for p in select * from jsonb_array_elements(m->'pages') loop
   if jsonb_typeof(p) is distinct from 'object' or char_length(coalesce(p->>'id','')) not between 1 and 200 or coalesce(p->>'kind','') not in ('pdf','blank') or (p->>'kind'='pdf' and (coalesce(p->>'pdfPage','')!~'^[0-9]+$' or (p->>'pdfPage')::integer not between 1 and 500)) then raise exception 'publication_invalid_materials';end if;
   pages:=pages||jsonb_build_array(jsonb_build_object('id',p->>'id','kind',p->>'kind')||case when p->>'kind'='pdf' then jsonb_build_object('pdfPage',(p->>'pdfPage')::integer) else '{}' end);
  end loop;
  if (select count(distinct x->>'id') from jsonb_array_elements(pages)x)<>jsonb_array_length(pages) then raise exception 'publication_invalid_materials';end if;
  pdf:=m->'pdf';
  if exists(select 1 from jsonb_array_elements(pages)x where x->>'kind'='pdf') and pdf is null then raise exception 'publication_pdf_missing';end if;
  if pdf is not null and (jsonb_typeof(pdf) is distinct from 'object' or coalesce(pdf->>'sha256','')!~'^[a-f0-9]{64}$' or coalesce(pdf->>'path','')<>actor::text||'/'||(pdf->>'sha256')||'.pdf' or coalesce(pdf->>'size','')!~'^[0-9]+$' or (pdf->>'size')::bigint not between 1 and 52428800) then raise exception 'publication_invalid_materials';end if;
  result:=result||jsonb_build_array(jsonb_build_object('id',m->>'id','title',coalesce(m->>'title',''),'pages',pages)||case when pdf is not null then jsonb_build_object('pdf',jsonb_build_object('path',pdf->>'path','sha256',pdf->>'sha256','size',(pdf->>'size')::bigint)) else '{}' end);
 end loop;
 if (select count(distinct x->>'id') from jsonb_array_elements(result)x)<>jsonb_array_length(result) then raise exception 'publication_invalid_materials';end if;
 return result;
end $$;
alter function quiz_private.publish_metadata(jsonb) rename to publish_metadata_before_pdf;
create function quiz_private.publish_metadata(value jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$ begin return quiz_private.publish_metadata_before_pdf(value)||case when value ? 'materials' then jsonb_build_object('materials',quiz_private.publication_materials(value->'materials',auth.uid())) else '{}' end;end $$;
alter function quiz_private.publish_question(jsonb,integer) rename to publish_question_before_pdf;
create function quiz_private.publish_question(value jsonb,expected_position integer) returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb;refs jsonb:=coalesce(value->'material_references','[]');r jsonb;clean jsonb:='[]';
begin
 result:=quiz_private.publish_question_before_pdf(value,expected_position);
 if jsonb_typeof(refs) is distinct from 'array' or jsonb_array_length(refs)>100 then raise exception 'publication_invalid_material_reference';end if;
 for r in select * from jsonb_array_elements(refs) loop
  if jsonb_typeof(r) is distinct from 'object' or char_length(coalesce(r->>'materialId','')) not between 1 and 200 or char_length(coalesce(r->>'pageId','')) not between 1 and 200 then raise exception 'publication_invalid_material_reference';end if;
  clean:=clean||jsonb_build_array(jsonb_build_object('materialId',r->>'materialId','pageId',r->>'pageId'));
 end loop;
 if jsonb_array_length(clean)>0 then result:=result||jsonb_build_object('material_references',clean);result:=result||jsonb_build_object('content_revision',encode(sha256(convert_to((result-array['logical_id','content_revision'])::text,'UTF8')),'hex'));end if;
 return result;
end $$;
create or replace function quiz_private.publish_finish(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.quiz_publish_jobs; source public.shared_problem_sets; target uuid; token text; version uuid; manifest jsonb; visibility text; requested_group text; published_updated_at timestamptz; v_materials jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid();
  if not found then raise exception 'not authorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||'/'||j.local_set_id,0));
  select * into j from private.quiz_publish_jobs where id=p_job_id and owner_id=auth.uid() for update;
  if not found then raise exception 'not authorized'; end if;
  if j.state='completed' then return quiz_private.publish_status(j.id); end if;
  if j.state<>'uploading' or j.expires_at<now() then raise exception 'publication_expired'; end if;
  if j.uploaded<>j.total then raise exception 'publication_incomplete'; end if;

  v_materials:=quiz_private.publication_materials(coalesce(j.metadata->'materials','[]'),j.owner_id);
  if exists(select 1 from jsonb_array_elements(v_materials)m where m ? 'pdf' and not exists(select 1 from storage.objects o where o.bucket_id='quiz-publication-pdfs' and o.name=m->'pdf'->>'path' and (o.metadata->>'size')::bigint=(m->'pdf'->>'size')::bigint and o.metadata->>'mimetype'='application/pdf')) then raise exception 'publication_pdf_missing';end if;
  if exists(select 1 from private.quiz_publish_questions q cross join lateral jsonb_array_elements(coalesce(q.question->'material_references','[]'))r where q.job_id=j.id and not exists(select 1 from jsonb_array_elements(v_materials)m cross join lateral jsonb_array_elements(m->'pages')p where m->>'id'=r->>'materialId' and p->>'id'=r->>'pageId')) then raise exception 'publication_invalid_material_reference';end if;
  select * into source from public.shared_problem_sets where owner_id=j.owner_id and local_set_id=j.local_set_id for update;
  if source.id is distinct from j.base_set_id or source.updated_at is distinct from j.base_updated_at or source.current_version_id is distinct from j.base_version_id then raise exception 'publication_conflict'; end if;
  for requested_group in select value from jsonb_array_elements_text(j.metadata->'group_ids') loop
    perform 1 from public.quiz_group_members m where m.group_id=requested_group::uuid and m.user_id=auth.uid() for share;
    if not found then raise exception 'not authorized'; end if;
  end loop;
  select jsonb_agg(question order by position) into manifest from private.quiz_publish_questions where job_id=j.id;
  if jsonb_array_length(manifest) is distinct from j.total then raise exception 'publication_incomplete'; end if;
  visibility:=case when (j.metadata->>'keep_visibility')::boolean and source.id is not null then source.visibility when (j.metadata->>'add_destinations')::boolean and source.visibility='public' then 'public' else j.metadata->>'visibility' end;
  insert into public.shared_problem_sets(owner_id,local_set_id,author_name,title,description,subject,audience,difficulty,creation_method,source,visibility,question_count,folder_path,published_at,updated_at)
    values(j.owner_id,j.local_set_id,j.metadata->>'author_name',j.metadata->>'title',j.metadata->>'description',j.metadata->>'subject',j.metadata->>'audience',j.metadata->>'difficulty',j.metadata->>'creation_method',j.metadata->>'source',visibility,j.total,coalesce(j.metadata->'folder_path','[]'),now(),now())
    on conflict(owner_id,local_set_id) do update set author_name=excluded.author_name,title=excluded.title,description=excluded.description,subject=excluded.subject,audience=excluded.audience,difficulty=excluded.difficulty,creation_method=excluded.creation_method,source=excluded.source,visibility=excluded.visibility,question_count=excluded.question_count,folder_path=case when j.metadata ? 'folder_path' then excluded.folder_path else public.shared_problem_sets.folder_path end,updated_at=now()
    where public.shared_problem_sets.id=j.base_set_id and public.shared_problem_sets.updated_at=j.base_updated_at and public.shared_problem_sets.current_version_id is not distinct from j.base_version_id
    returning id,share_token,updated_at into target,token,published_updated_at;
  if target is null then raise exception 'publication_conflict'; end if;
  if exists(select 1 from private.quiz_publication_versions where id=j.base_version_id and set_id=target and questions=manifest and materials=v_materials) then version:=j.base_version_id;
  else insert into private.quiz_publication_versions(set_id,questions,materials) values(target,manifest,v_materials) returning id into version; end if;
  if not (j.metadata->>'add_destinations')::boolean then delete from public.quiz_group_problem_sets where set_id=target; end if;
  for requested_group in select value from jsonb_array_elements_text(j.metadata->'group_ids') loop
    insert into public.quiz_group_problem_sets(group_id,set_id,shared_by) values(requested_group::uuid,target,j.owner_id) on conflict do nothing;
  end loop;
  update public.shared_problem_sets set current_version_id=version where id=target;
  update private.quiz_publish_jobs set state='completed',result=jsonb_build_object('id',target,'share_token',token,'version_id',version,'visibility',visibility,'updated_at',published_updated_at) where id=j.id;
  -- Only this job's temporary staging is retired. Existing versions/legacy rows remain.
  delete from private.quiz_publish_questions where job_id=j.id;
  delete from private.quiz_publish_parts where job_id=j.id;
  return quiz_private.publish_status(j.id);
end $$;


create function quiz_private.publication_pdf_access(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.shared_problem_sets s join private.quiz_publication_versions v on v.id=s.current_version_id and v.set_id=s.id cross join lateral jsonb_array_elements(v.materials)m where m->'pdf'->>'path'=p_path and (
 s.owner_id=auth.uid() or quiz_public_api.can_read(s.id) or exists(select 1 from public.quiz_group_problem_sets g join public.quiz_group_members member on member.group_id=g.group_id where g.set_id=s.id and member.user_id=auth.uid()) or exists(select 1 from private.quiz_publication_pdf_grants a where a.user_id=auth.uid() and a.set_id=s.id and a.version_id=v.id and a.path=p_path and a.expires_at>now() and a.token_hash=encode(sha256(convert_to(s.share_token,'UTF8')),'hex'))))
$$;
create function public.quiz_publication_material_read(p_set_id uuid,p_version_id uuid,p_path text,p_share_token text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.shared_problem_sets;
begin
 select * into s from public.shared_problem_sets where id=p_set_id and current_version_id=p_version_id;
 if not found or not exists(select 1 from private.quiz_publication_versions v cross join lateral jsonb_array_elements(v.materials)m where v.id=p_version_id and v.set_id=s.id and m->'pdf'->>'path'=p_path) then raise exception 'not authorized';end if;
 if quiz_private.publication_pdf_access(p_path) then return true;end if;
 if auth.uid() is null or p_share_token is null or p_share_token<>s.share_token then raise exception 'not authorized';end if;
 perform public.get_shared_problem_set(p_set_id,p_share_token);
 insert into private.quiz_publication_pdf_grants(user_id,set_id,version_id,path,token_hash,expires_at) values(auth.uid(),s.id,p_version_id,p_path,encode(sha256(convert_to(s.share_token,'UTF8')),'hex'),now()+interval '2 minutes') on conflict(user_id,set_id,path) do update set version_id=excluded.version_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at;
 return true;
end $$;
create policy quiz_publication_pdf_insert on storage.objects for insert to authenticated with check(bucket_id='quiz-publication-pdfs' and auth.uid() is not null and name ~ ('^'||auth.uid()::text||'/[a-f0-9]{64}\.pdf$'));
create policy quiz_publication_pdf_select on storage.objects for select to anon,authenticated using(bucket_id='quiz-publication-pdfs' and ((auth.uid() is not null and name ~ ('^'||auth.uid()::text||'/[a-f0-9]{64}\.pdf$')) or quiz_private.publication_pdf_access(name)));
-- No UPDATE/DELETE policy: shared bytes are immutable, including for their owner.
alter function public.get_shared_problem_set_versioned(uuid,text) rename to get_shared_problem_set_before_pdf;
create function public.get_shared_problem_set_versioned(p_set_id uuid,p_share_token text default null) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare result jsonb;materials jsonb;begin
 result:=public.get_shared_problem_set_before_pdf(p_set_id,p_share_token);if result is null then return null;end if;
 select v.materials into materials from private.quiz_publication_versions v where v.id=(result->>'version_id')::uuid and v.set_id=p_set_id;
 return result||jsonb_build_object('materials',coalesce(materials,'[]'));
end $$;
alter function public.quiz_get_publication_version(uuid,uuid,text) rename to quiz_get_publication_version_before_pdf;
create function public.quiz_get_publication_version(p_set_id uuid,p_version_id uuid,p_share_token text default null) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare result jsonb;materials jsonb;begin
 result:=public.quiz_get_publication_version_before_pdf(p_set_id,p_version_id,p_share_token);select v.materials into materials from private.quiz_publication_versions v where v.id=p_version_id and v.set_id=p_set_id;return result||jsonb_build_object('materials',coalesce(materials,'[]'));
end $$;
revoke all on function quiz_private.publication_materials(jsonb,uuid),quiz_private.publish_metadata(jsonb),quiz_private.publish_metadata_before_pdf(jsonb),quiz_private.publish_question(jsonb,integer),quiz_private.publish_question_before_pdf(jsonb,integer),quiz_private.publish_finish(uuid),quiz_private.publication_pdf_access(text),public.get_shared_problem_set_before_pdf(uuid,text),public.quiz_get_publication_version_before_pdf(uuid,uuid,text),public.quiz_publication_material_read(uuid,uuid,text,text),public.get_shared_problem_set_versioned(uuid,text),public.quiz_get_publication_version(uuid,uuid,text) from public,anon,authenticated;
grant execute on function quiz_private.publication_pdf_access(text),public.quiz_publication_material_read(uuid,uuid,text,text),public.get_shared_problem_set_versioned(uuid,text),public.quiz_get_publication_version(uuid,uuid,text) to anon,authenticated;

grant execute on function quiz_private.publish_finish(uuid) to authenticated;
