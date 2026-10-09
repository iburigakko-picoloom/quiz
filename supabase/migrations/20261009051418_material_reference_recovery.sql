-- Admin-only, additive recovery from an exact historical material record.
-- No parent, question, deletion tombstone, or existing attachment is removed.
create table private.quiz_material_recovery_backups (
  recovery_id text primary key,
  sync_id text not null,
  before_revision bigint not null,
  applied_revision bigint not null,
  originals jsonb not null,
  originals_sha256 text not null,
  recovered_rows jsonb not null,
  created_at timestamptz not null default now()
);
alter table private.quiz_material_recovery_backups enable row level security;
revoke all on table private.quiz_material_recovery_backups from public,anon,authenticated,service_role;

create function private.quiz_recover_material_from_history(
  p_sync_id text,p_material_id text,p_target_set_id text,p_expected_revision bigint,
  p_history_revision bigint,p_verified_pdf_sha256 text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  h private.quiz_sync_heads; b private.quiz_material_recovery_backups;
  rid text; idx jsonb; mat jsonb; pdf jsonb; old_owner text; target_idx jsonb;
  idx_key text; pdf_key text; rows jsonb; v_originals jsonb; saved_at timestamptz;
  cnt integer; refs integer; total_bytes bigint; next_revision bigint;
begin
  if p_material_id is null or p_target_set_id is null or p_verified_pdf_sha256 !~ '^[a-f0-9]{64}$'
    or p_verified_pdf_sha256 is null or p_expected_revision is null or p_history_revision is null then
    raise exception 'invalid_recovery_arguments';
  end if;
  perform private.quiz_sync_lock_id(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id for update;
  if not found then raise exception 'missing_sync_head'; end if;
  rid:=encode(sha256(convert_to(jsonb_build_array(p_sync_id,p_material_id,p_target_set_id,p_history_revision,p_verified_pdf_sha256)::text,'UTF8')),'hex');
  select * into b from private.quiz_material_recovery_backups where recovery_id=rid;
  if found then
    if b.originals_sha256<>encode(sha256(convert_to(b.originals::text,'UTF8')),'hex') then raise exception 'backup_integrity'; end if;
    if exists(select 1 from jsonb_array_elements(b.recovered_rows) x where not exists(
      select 1 from private.quiz_sync_records r where r.sync_id=p_sync_id and r.record_key=x->>'key' and r.raw=x->>'raw')) then
      raise exception 'recovered_records_changed';
    end if;
    return jsonb_build_object('code','already_recovered','revision',b.applied_revision,'rows',jsonb_array_length(b.recovered_rows));
  end if;
  if h.revision<>p_expected_revision then raise exception 'remote_changed'; end if;
  if exists(select 1 from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-commit' and operation->>'state'='staging') then
    raise exception 'sync_busy';
  end if;
  if not exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and collection='problemSets' and record_id=p_target_set_id and raw is not null) then
    raise exception 'missing_target_set';
  end if;
  select count(*),jsonb_agg((x->>'raw')::jsonb)->0 into cnt,idx
    from private.quiz_sync_changes c cross join lateral jsonb_array_elements(c.changes) x
    where c.sync_id=p_sync_id and c.revision=p_history_revision and x->>'collection'='indexedDbNotes'
      and x->>'raw' is not null and (x->>'raw')::jsonb->>'kind'='quiz-material-index'
      and exists(select 1 from jsonb_array_elements((x->>'raw')::jsonb->'materials') m where m->>'id'=p_material_id);
  if cnt<>1 or idx->>'version' is distinct from '1' or coalesce(idx->>'problemSetId','')='' then raise exception 'ambiguous_historical_index'; end if;
  old_owner:=idx->>'problemSetId';
  if exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and collection='problemSets' and record_id=old_owner and raw is not null) then
    raise exception 'source_owner_still_live';
  end if;
  select count(*),jsonb_agg(m)->0 into cnt,mat from jsonb_array_elements(idx->'materials') m where m->>'id'=p_material_id;
  if cnt<>1 or jsonb_typeof(mat->'pages') is distinct from 'array' or jsonb_array_length(mat->'pages')=0 or
    (select count(distinct p->>'id') from jsonb_array_elements(mat->'pages') p)<>jsonb_array_length(mat->'pages') then
    raise exception 'invalid_historical_pages';
  end if;
  select count(*),jsonb_agg((x->>'raw')::jsonb)->0 into cnt,pdf
    from private.quiz_sync_changes c cross join lateral jsonb_array_elements(c.changes) x
    where c.sync_id=p_sync_id and c.revision=p_history_revision and x->>'collection'='indexedDbNotes'
      and x->>'id'='quizMake:notes:'||old_owner||':__material_pdf_'||p_material_id and x->>'raw' is not null;
  if cnt<>1 or pdf->>'kind' is distinct from 'quiz-material-remote-file' or pdf->>'version' is distinct from '1' or pdf->>'materialId' is distinct from p_material_id
    or pdf->>'sha256' is distinct from p_verified_pdf_sha256 or pdf->>'bucket' is distinct from 'quiz-material-pdfs'
    or pdf->>'size' is null or (pdf->>'size')::bigint not between 1 and 52428800
    or pdf->>'path' is null or pdf->>'path' !~ '^[a-f0-9-]{36}/[a-f0-9]{64}\.pdf$' or pdf->>'path' not like '%/'||p_verified_pdf_sha256||'.pdf' then
    raise exception 'historical_pdf_mismatch';
  end if;
  if not exists(select 1 from storage.objects where bucket_id=pdf->>'bucket' and name=pdf->>'path'
    and (metadata->>'size')::bigint=(pdf->>'size')::bigint) then raise exception 'pdf_object_missing'; end if;
  if exists(select 1 from private.quiz_sync_records r cross join lateral jsonb_array_elements(r.raw::jsonb->'materials') m
    where r.sync_id=p_sync_id and r.collection='indexedDbNotes' and r.raw is not null and r.record_id like '%:__materials_v1' and m->>'id'=p_material_id) then
    raise exception 'material_already_owned';
  end if;
  select count(*) into refs from private.quiz_sync_records r cross join lateral jsonb_array_elements(coalesce(r.raw::jsonb->'materialReferences','[]')) ref
    where r.sync_id=p_sync_id and r.collection='questions' and r.raw is not null and r.raw::jsonb->>'setId'=p_target_set_id and ref->>'materialId'=p_material_id;
  if refs=0 or exists(select 1 from private.quiz_sync_records r cross join lateral jsonb_array_elements(coalesce(r.raw::jsonb->'materialReferences','[]')) ref
    where r.sync_id=p_sync_id and r.collection='questions' and r.raw is not null and ref->>'materialId'=p_material_id
      and not exists(select 1 from jsonb_array_elements(mat->'pages') p where p->>'id'=ref->>'pageId')) then
    raise exception 'unproven_reference';
  end if;
  idx_key:='quizMake:notes:'||p_target_set_id||':__materials_v1';pdf_key:='quizMake:notes:'||p_target_set_id||':__material_pdf_'||p_material_id;
  select raw::jsonb into target_idx from private.quiz_sync_records where sync_id=p_sync_id and collection='indexedDbNotes' and record_id=idx_key;
  if found and target_idx is null then raise exception 'target_index_deleted'; end if;
  if target_idx is not null and (target_idx->>'kind' is distinct from 'quiz-material-index' or target_idx->>'problemSetId' is distinct from p_target_set_id or target_idx->>'version' is distinct from '1' or jsonb_typeof(target_idx->'materials') is distinct from 'array') then raise exception 'invalid_target_index'; end if;
  if exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and collection='indexedDbNotes' and record_id=pdf_key) then raise exception 'target_pdf_exists'; end if;
  next_revision:=h.revision+1;if next_revision>9007199254740991 then raise exception 'revision_exhausted'; end if;
  saved_at:=greatest(clock_timestamp(),h.snapshot_updated_at+interval '1 microsecond');
  target_idx:=coalesce(target_idx,jsonb_build_object('kind','quiz-material-index','version',1,'problemSetId',p_target_set_id,'materials','[]'::jsonb))
    ||jsonb_build_object('materials',coalesce(target_idx->'materials','[]'::jsonb)||jsonb_build_array(mat),'updatedAt',saved_at);
  rows:=jsonb_build_array(
    jsonb_build_object('key',private.quiz_sync_record_key('indexedDbNotes',idx_key),'collection','indexedDbNotes','id',idx_key,'raw',target_idx::text,'position',0),
    jsonb_build_object('key',private.quiz_sync_record_key('indexedDbNotes',pdf_key),'collection','indexedDbNotes','id',pdf_key,'raw',pdf::text,'position',1));
  v_originals:=jsonb_build_object('head',to_jsonb(h),'records',(select jsonb_agg(to_jsonb(r) order by record_key) from private.quiz_sync_records r where sync_id=p_sync_id),
    'legacySnapshot',(select to_jsonb(d) from public.quiz_sync_data d where sync_id=p_sync_id),'historicalIndex',idx,'historicalPdf',pdf);
  insert into private.quiz_material_recovery_backups values(rid,p_sync_id,h.revision,next_revision,v_originals,encode(sha256(convert_to(v_originals::text,'UTF8')),'hex'),rows,now());
  if not exists(select 1 from private.quiz_material_recovery_backups where recovery_id=rid and originals=v_originals
    and originals_sha256=encode(sha256(convert_to(v_originals::text,'UTF8')),'hex')) then raise exception 'backup_readback_failed'; end if;
  insert into private.quiz_sync_records(sync_id,record_key,collection,record_id,raw,position,revision)
    select p_sync_id,x->>'key',x->>'collection',x->>'id',x->>'raw',(x->>'position')::integer,next_revision from jsonb_array_elements(rows) x
    on conflict(sync_id,record_key) do update set raw=excluded.raw,revision=excluded.revision;
  select coalesce(sum(octet_length(raw)),0) into total_bytes from private.quiz_sync_records where sync_id=p_sync_id;
  if total_bytes>134217728 then raise exception 'recovery_quota'; end if;
  insert into private.quiz_sync_changes values(p_sync_id,next_revision,rows);
  update public.quiz_sync_data set updated_at=saved_at,last_accessed_at=saved_at where sync_id=p_sync_id;
  update private.quiz_sync_heads set revision=next_revision,snapshot_updated_at=saved_at,payload_bytes=total_bytes,whole_saved_at=saved_at,whole_device='資料参照の保全修復' where sync_id=p_sync_id;
  return jsonb_build_object('code','recovered','revision',next_revision,'rows',2,'references',refs);
end $$;
revoke all on function private.quiz_recover_material_from_history(text,text,text,bigint,bigint,text) from public,anon,authenticated,service_role;
