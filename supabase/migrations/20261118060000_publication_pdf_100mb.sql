create or replace function quiz_private.publication_materials(value jsonb,actor uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
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
  if pdf is not null and (jsonb_typeof(pdf) is distinct from 'object' or coalesce(pdf->>'sha256','')!~'^[a-f0-9]{64}$' or coalesce(pdf->>'path','')<>actor::text||'/'||(pdf->>'sha256')||'.pdf' or coalesce(pdf->>'size','')!~'^[0-9]+$' or (pdf->>'size')::bigint not between 1 and 104857600) then raise exception 'publication_invalid_materials';end if;
  result:=result||jsonb_build_array(jsonb_build_object('id',m->>'id','title',coalesce(m->>'title',''),'pages',pages)||case when pdf is not null then jsonb_build_object('pdf',jsonb_build_object('path',pdf->>'path','sha256',pdf->>'sha256','size',(pdf->>'size')::bigint)) else '{}' end);
 end loop;
 if (select count(distinct x->>'id') from jsonb_array_elements(result)x)<>jsonb_array_length(result) then raise exception 'publication_invalid_materials';end if;
 return result;
end $$;
create or replace function quiz_private.publication_pdf_access(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.shared_problem_sets s join private.quiz_publication_versions v on v.id=s.current_version_id and v.set_id=s.id cross join lateral jsonb_array_elements(v.materials)m where (m->'pdf'->>'path'=p_path or ((m->'pdf'->>'size')::bigint > 52428800 and p_path in ((m->'pdf'->>'path')||'.1',(m->'pdf'->>'path')||'.2'))) and (
 s.owner_id=auth.uid() or quiz_public_api.can_read(s.id) or exists(select 1 from public.quiz_group_problem_sets g join public.quiz_group_members member on member.group_id=g.group_id where g.set_id=s.id and member.user_id=auth.uid()) or exists(select 1 from private.quiz_publication_pdf_grants a where a.user_id=auth.uid() and a.set_id=s.id and a.version_id=v.id and a.path=m->'pdf'->>'path' and a.expires_at>now() and a.token_hash=encode(sha256(convert_to(s.share_token,'UTF8')),'hex'))))
$$;
alter policy quiz_publication_pdf_insert on storage.objects with check(bucket_id='quiz-publication-pdfs' and auth.uid() is not null and name ~ ('^'||auth.uid()::text||'/[a-f0-9]{64}\.pdf(\.[12])?$'));
alter policy quiz_publication_pdf_select on storage.objects using(bucket_id='quiz-publication-pdfs' and ((auth.uid() is not null and name ~ ('^'||auth.uid()::text||'/[a-f0-9]{64}\.pdf(\.[12])?$')) or quiz_private.publication_pdf_access(name)));

-- Preserve subsequent revisions of the publication transaction.
do $migration$
declare
  definition text := pg_get_functiondef('quiz_private.publish_finish(uuid)'::regprocedure);
  old_guard text := $old$not exists(select 1 from storage.objects o where o.bucket_id='quiz-publication-pdfs' and o.name=m->'pdf'->>'path' and (o.metadata->>'size')::bigint=(m->'pdf'->>'size')::bigint and o.metadata->>'mimetype'='application/pdf')$old$;
begin
  if strpos(definition,old_guard)=0 then raise exception 'unexpected publication guard'; end if;
  execute replace(definition,old_guard,$new$exists (
    select 1 from generate_series(1, case when (m->'pdf'->>'size')::bigint > 52428800 then 2 else 1 end) as part(n)
    where not exists (
      select 1 from storage.objects o where o.bucket_id='quiz-publication-pdfs'
      and o.name=(m->'pdf'->>'path') || case when (m->'pdf'->>'size')::bigint > 52428800 then '.'||part.n::text else '' end
      and (o.metadata->>'size')::bigint=least(52428800,(m->'pdf'->>'size')::bigint-(part.n-1)*52428800)
      and o.metadata->>'mimetype'='application/pdf'
    )
  )$new$);
end $migration$;
