-- REVIEW ONLY: this migration has not been approved for production application.
-- Whole commits reuse the existing head, records and UUID operation receipts.
-- Temporary parts are private, bounded, owner-scoped and invisible to readers.
alter table private.quiz_sync_heads add column whole_enabled boolean not null default false;
alter table private.quiz_sync_heads add column whole_device text;
alter table private.quiz_sync_heads add column whole_saved_at timestamptz;

create function private.quiz_whole_status(p_sync_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare h private.quiz_sync_heads;
begin
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  return jsonb_build_object('code','ok','revision',h.revision,'enabled',h.whole_enabled,'device',h.whole_device,'savedAt',h.whole_saved_at);
end $$;

create function private.quiz_whole_open(p_sync_id text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare h private.quiz_sync_heads;
begin
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id for update;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if p_expected_revision is null or h.revision<>p_expected_revision then return jsonb_build_object('code','conflict'); end if;
  update private.quiz_sync_heads set whole_enabled=true where sync_id=p_sync_id;
  return jsonb_build_object('code','ok','revision',h.revision);
end $$;

create function private.quiz_whole_read(p_sync_id text,p_expected_revision bigint,p_after_key text default '',p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare h private.quiz_sync_heads; rows jsonb:='[]'; row private.quiz_sync_records; bytes bigint:=0; last_key text:=p_after_key; more boolean;
begin
  perform private.enforce_quiz_sync_rate_limit('whole_read',120,interval '1 minute');
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if p_expected_revision is null or h.revision<>p_expected_revision then return jsonb_build_object('code','conflict'); end if;
  if p_after_key is null or octet_length(p_after_key)>2048 or p_limit not between 1 and 500 then return jsonb_build_object('code','invalid'); end if;
  for row in select * from private.quiz_sync_records where sync_id=p_sync_id and raw is not null and record_key collate "C">p_after_key collate "C" order by record_key collate "C" limit p_limit loop
    -- Each record is already bounded by the record/chunk contract. Include one
    -- maximal row for progress, then stop before the next ~900 KiB page boundary.
    if jsonb_array_length(rows)>0 and bytes+octet_length(row.raw)+octet_length(row.record_key)+256>921600 then exit; end if;
    rows:=rows||jsonb_build_array(jsonb_build_object('key',row.record_key,'collection',row.collection,'id',row.record_id,'raw',row.raw,'position',row.position,'revision',row.revision));
    bytes:=bytes+octet_length(row.raw)+octet_length(row.record_key)+256;last_key:=row.record_key;
  end loop;
  select exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and raw is not null and record_key collate "C">last_key collate "C") into more;
  return jsonb_build_object('code','ok','revision',h.revision,'rows',rows,'afterKey',last_key,'hasMore',more);
end $$;

create function private.quiz_whole_begin(p_sync_id text,p_operation_id uuid,p_expected_revision bigint,p_parts integer,p_records integer,p_digest text,p_device text,p_replace boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare h private.quiz_sync_heads; old private.quiz_sync_operations; manifest jsonb;
begin
  perform private.enforce_quiz_sync_rate_limit('whole_begin',12,interval '1 minute');
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id for update;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if not h.whole_enabled then return jsonb_build_object('code','not_enabled'); end if;
  if p_operation_id is null or p_expected_revision is null or p_replace is null or p_parts is null or p_records is null or p_parts not between 1 and 512 or p_records not between 0 and 200000
    or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_device is null or octet_length(p_device) not between 1 and 160 then return jsonb_build_object('code','invalid'); end if;
  manifest:=jsonb_build_object('kind','whole-commit','expectedRevision',p_expected_revision,'parts',p_parts,'records',p_records,'digest',p_digest,'device',p_device,'replace',p_replace);
  select * into old from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=p_operation_id;
  if found then
    if old.operation-'state'-'expiresAt'<>manifest then return jsonb_build_object('code','operation_reused'); end if;
    return jsonb_build_object('code','ok','state',old.operation->>'state','revision',old.revision);
  end if;
  if h.revision<>p_expected_revision then return jsonb_build_object('code','conflict'); end if;
  -- Only this dataset's expired temporary data is removed. Committed receipts
  -- stay available for lost-response retries; live records/history are untouched.
  delete from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-part'
    and operation->>'commitId' in(select operation_id::text from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-commit' and operation->>'state'='staging' and (operation->>'expiresAt')::timestamptz<clock_timestamp());
  delete from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-commit' and operation->>'state'='staging' and (operation->>'expiresAt')::timestamptz<clock_timestamp();
  if exists(select 1 from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-commit' and operation->>'state'='staging') then return jsonb_build_object('code','busy'); end if;
  insert into private.quiz_sync_operations values(p_sync_id,p_operation_id,manifest||jsonb_build_object('state','staging','expiresAt',clock_timestamp()+interval '1 hour'),h.revision);
  return jsonb_build_object('code','ok','state','staging','revision',h.revision);
end $$;

create function private.quiz_whole_part(p_sync_id text,p_commit_id uuid,p_operation_id uuid,p_number integer,p_raw text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare h private.quiz_sync_heads; commit_row private.quiz_sync_operations; old private.quiz_sync_operations; op jsonb; rows jsonb; row jsonb; total_bytes bigint;
begin
  perform private.enforce_quiz_sync_rate_limit('whole_part',120,interval '1 minute');
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if not h.whole_enabled then return jsonb_build_object('code','not_enabled'); end if;
  select * into commit_row from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=p_commit_id and operation->>'kind'='whole-commit';
  if not found or commit_row.operation->>'state'<>'staging' or (commit_row.operation->>'expiresAt')::timestamptz<clock_timestamp() then return jsonb_build_object('code','expired'); end if;
  if h.revision<>(commit_row.operation->>'expectedRevision')::bigint then return jsonb_build_object('code','conflict'); end if;
  if p_operation_id is null or p_number is null or p_number<0 or p_number>=(commit_row.operation->>'parts')::integer or p_raw is null or octet_length(p_raw)>1048576 then return jsonb_build_object('code','invalid'); end if;
  begin rows:=p_raw::jsonb;exception when invalid_text_representation then return jsonb_build_object('code','invalid');end;
  if jsonb_typeof(rows)<>'array' or jsonb_array_length(rows)>500 then return jsonb_build_object('code','invalid'); end if;
  for row in select value from jsonb_array_elements(rows) loop
    if jsonb_typeof(row)<>'object' or not row ?& array['key','collection','id','raw','position'] or row->>'key' is null or row->>'id' is null
      or coalesce(row->>'collection','') not in('folders','problemSets','questions','progress','answerLogs','localStorage','indexedDbNotes','questionImages')
      or octet_length(row->>'id') not between 1 and 1024 or octet_length(row->>'key')>2048
      or row->>'key'<>private.quiz_sync_record_key(row->>'collection',row->>'id') or jsonb_typeof(row->'raw') not in('string','null')
      or (jsonb_typeof(row->'raw')='null' and (commit_row.operation->>'replace')::boolean)
      or octet_length(row->>'raw')>1048576 or coalesce(row->>'position','') !~ '^[0-9]{1,9}$'
      or not private.quiz_sync_record_value_valid(row->>'collection',row->>'id',row->>'raw') then return jsonb_build_object('code','invalid'); end if;
  end loop;
  if (select count(distinct value->>'key') from jsonb_array_elements(rows))<>jsonb_array_length(rows) then return jsonb_build_object('code','invalid'); end if;
  op:=jsonb_build_object('kind','whole-part','commitId',p_commit_id,'number',p_number,'raw',p_raw,'sha256',encode(sha256(convert_to(p_raw,'UTF8')),'hex'));
  select * into old from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=p_operation_id;
  if found then if old.operation<>op then return jsonb_build_object('code','operation_reused');end if;return jsonb_build_object('code','ok');end if;
  if exists(select 1 from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-part' and operation->>'commitId'=p_commit_id::text and (operation->>'number')::integer=p_number) then return jsonb_build_object('code','operation_reused'); end if;
  select coalesce(sum(octet_length(o.operation->>'raw')),0) into total_bytes from private.quiz_sync_operations o join public.quiz_sync_data d on d.sync_id=o.sync_id where d.creator_hash=private.quiz_sync_actor_hash() and o.operation->>'kind'='whole-part';
  -- Framing/JSON escaping is temporary; final live metadata keeps the existing
  -- 128 MiB quota. Temporary framing is capped separately at twice that size.
  if total_bytes+octet_length(p_raw)>268435456 then return jsonb_build_object('code','quota'); end if;
  insert into private.quiz_sync_operations values(p_sync_id,p_operation_id,op,h.revision);
  return jsonb_build_object('code','ok');
end $$;

create function private.quiz_whole_finish(p_sync_id text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare h private.quiz_sync_heads; c private.quiz_sync_operations; rows jsonb; part_count integer; row_count integer; actual_digest text; total_bytes bigint; account_bytes bigint; next_revision bigint; saved_at timestamptz;
begin
  perform private.enforce_quiz_sync_rate_limit('whole_finish',12,interval '1 minute');
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id for update;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if not h.whole_enabled then return jsonb_build_object('code','not_enabled'); end if;
  select * into c from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=p_operation_id and operation->>'kind'='whole-commit';
  if not found then return jsonb_build_object('code','not_found');end if;
  if c.operation->>'state'='committed' then return jsonb_build_object('code','ok','revision',c.revision);end if;
  if (c.operation->>'expiresAt')::timestamptz<clock_timestamp() then return jsonb_build_object('code','expired');end if;
  if h.revision<>(c.operation->>'expectedRevision')::bigint then return jsonb_build_object('code','conflict');end if;
  select count(*),encode(sha256(convert_to(coalesce(string_agg(operation->>'sha256','' order by (operation->>'number')::integer),''),'UTF8')),'hex') into part_count,actual_digest
    from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-part' and operation->>'commitId'=p_operation_id::text;
  if part_count<>(c.operation->>'parts')::integer or actual_digest<>c.operation->>'digest' then return jsonb_build_object('code','incomplete');end if;
  select coalesce(jsonb_agg(x.value),'[]'),count(*),coalesce(sum(octet_length(x.value->>'raw')),0) into rows,row_count,total_bytes
    from private.quiz_sync_operations o cross join lateral jsonb_array_elements((o.operation->>'raw')::jsonb) x
    where o.sync_id=p_sync_id and o.operation->>'kind'='whole-part' and o.operation->>'commitId'=p_operation_id::text;
  if row_count<>(c.operation->>'records')::integer or (select count(distinct value->>'key') from jsonb_array_elements(rows))<>row_count then return jsonb_build_object('code','invalid');end if;
  if not (c.operation->>'replace')::boolean then
    select h.payload_bytes+coalesce(sum(coalesce(octet_length(x->>'raw'),0)-coalesce(octet_length(r.raw),0)),0) into total_bytes
      from jsonb_array_elements(rows) x left join private.quiz_sync_records r on r.sync_id=p_sync_id and r.record_key=x->>'key';
  end if;
  perform private.quiz_sync_lock_quota_actor(private.quiz_sync_actor_hash());
  select coalesce(sum(d.payload_bytes),0)+coalesce((select sum(head.payload_bytes) from private.quiz_sync_heads head join public.quiz_sync_data ds on ds.sync_id=head.sync_id where ds.creator_hash=private.quiz_sync_actor_hash() and head.sync_id<>p_sync_id),0) into account_bytes
    from public.quiz_sync_data d where d.creator_hash=private.quiz_sync_actor_hash();
  if account_bytes+total_bytes>134217728 then return jsonb_build_object('code','quota');end if;
  next_revision:=h.revision+1;if next_revision>9007199254740991 then return jsonb_build_object('code','revision_exhausted');end if;
  -- Existing rows absent from the chosen whole snapshot become tombstones.
  -- No records from the nonchosen snapshot are unioned into the selected one.
  if (c.operation->>'replace')::boolean then
    update private.quiz_sync_records r set raw=null,revision=next_revision where sync_id=p_sync_id and raw is not null and not exists(select 1 from jsonb_array_elements(rows) x where x->>'key'=r.record_key);
  end if;
  insert into private.quiz_sync_records(sync_id,record_key,collection,record_id,raw,position,revision)
    select p_sync_id,x->>'key',x->>'collection',x->>'id',x->>'raw',(x->>'position')::integer,next_revision from jsonb_array_elements(rows) x
    on conflict(sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision;
  saved_at:=greatest(clock_timestamp(),h.snapshot_updated_at+interval '1 microsecond');
  update public.quiz_sync_data set updated_at=saved_at,last_accessed_at=saved_at where sync_id=p_sync_id;
  update private.quiz_sync_heads set revision=next_revision,payload_bytes=total_bytes,snapshot_updated_at=saved_at,whole_device=c.operation->>'device',whole_saved_at=saved_at where sync_id=p_sync_id;
  update private.quiz_sync_operations set operation=operation||jsonb_build_object('state','committed'),revision=next_revision where sync_id=p_sync_id and operation_id=p_operation_id;
  delete from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-part' and operation->>'commitId'=p_operation_id::text;
  return jsonb_build_object('code','ok','revision',next_revision);
end $$;

-- Old writers are fenced only after this owner has enabled this dataset.
create function private.quiz_whole_abort(p_sync_id text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.quiz_sync_operations;
begin
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into c from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=p_operation_id and operation->>'kind'='whole-commit';
  if not found then return jsonb_build_object('code','not_committed');end if;
  if c.operation->>'state'='committed' then return jsonb_build_object('code','committed','revision',c.revision);end if;
  delete from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-part' and operation->>'commitId'=p_operation_id::text;
  delete from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=p_operation_id;
  return jsonb_build_object('code','not_committed');
end $$;
-- A pre-upgrade batch may have committed before the old writer fence appeared.
-- Resolve its exact existing receipts without granting a route around the fence.
create function private.quiz_whole_receipts(p_sync_id text,p_operations jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op jsonb; receipt private.quiz_sync_operations; ack jsonb:='[]'; revision bigint;
begin
  perform private.quiz_sync_v2_access(p_sync_id);
  if p_operations is null or jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations) not between 1 and 500 or octet_length(p_operations::text)>1048576 then return jsonb_build_object('code','invalid');end if;
  for op in select value from jsonb_array_elements(p_operations) loop
    if coalesce(op->>'operationId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return jsonb_build_object('code','invalid');end if;
    select * into receipt from private.quiz_sync_operations where sync_id=p_sync_id and operation_id=(op->>'operationId')::uuid;
    if not found then return jsonb_build_object('code','not_committed');end if;
    if receipt.operation<>op then return jsonb_build_object('code','operation_reused');end if;
    ack:=ack||jsonb_build_array(jsonb_build_object('operationId',op->>'operationId','key',op->>'key','revision',receipt.revision));
  end loop;
  select h.revision into revision from private.quiz_sync_heads h where sync_id=p_sync_id;
  return jsonb_build_object('code','ok','revision',revision,'ack',ack);
end $$;

create function private.quiz_whole_snapshot_fence() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.quiz_sync_lock_id(new.sync_id);
  if exists(select 1 from private.quiz_sync_heads where sync_id=new.sync_id and whole_enabled) then raise exception using errcode='55000',message='whole_required';end if;
  return new;
end $$;
create trigger quiz_whole_snapshot_fence before update of data on public.quiz_sync_data for each row execute function private.quiz_whole_snapshot_fence();

alter function private.quiz_sync_v2_push(text,jsonb) rename to quiz_sync_v2_push_record;
create function private.quiz_sync_v2_push(p_sync_id text,p_operations jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.quiz_sync_v2_access(p_sync_id);if exists(select 1 from private.quiz_sync_heads where sync_id=p_sync_id and whole_enabled) then return jsonb_build_object('code','whole_required');end if;return private.quiz_sync_v2_push_record(p_sync_id,p_operations);end $$;
alter function private.quiz_sync_v2_pull(text,bigint,integer) rename to quiz_sync_v2_pull_record;
create function private.quiz_sync_v2_pull(p_sync_id text,p_cursor bigint,p_limit integer default 10) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.quiz_sync_v2_access(p_sync_id);if exists(select 1 from private.quiz_sync_heads where sync_id=p_sync_id and whole_enabled) then return jsonb_build_object('code','whole_required');end if;return private.quiz_sync_v2_pull_record(p_sync_id,p_cursor,p_limit);end $$;

create function public.quiz_whole_status(p_sync_id text) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_status(p_sync_id)$$;
create function public.quiz_whole_open(p_sync_id text,p_expected_revision bigint) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_open(p_sync_id,p_expected_revision)$$;
create function public.quiz_whole_read(p_sync_id text,p_expected_revision bigint,p_after_key text default '',p_limit integer default 200) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_read(p_sync_id,p_expected_revision,p_after_key,p_limit)$$;
create function public.quiz_whole_begin(p_sync_id text,p_operation_id uuid,p_expected_revision bigint,p_parts integer,p_records integer,p_digest text,p_device text,p_replace boolean default true) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_begin(p_sync_id,p_operation_id,p_expected_revision,p_parts,p_records,p_digest,p_device,p_replace)$$;
create function public.quiz_whole_part(p_sync_id text,p_commit_id uuid,p_operation_id uuid,p_number integer,p_raw text) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_part(p_sync_id,p_commit_id,p_operation_id,p_number,p_raw)$$;
create function public.quiz_whole_finish(p_sync_id text,p_operation_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_finish(p_sync_id,p_operation_id)$$;
create function public.quiz_whole_abort(p_sync_id text,p_operation_id uuid) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_abort(p_sync_id,p_operation_id)$$;
create function public.quiz_whole_receipts(p_sync_id text,p_operations jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.quiz_whole_receipts(p_sync_id,p_operations)$$;

revoke all on function private.quiz_sync_v2_push_record(text,jsonb),private.quiz_sync_v2_pull_record(text,bigint,integer),private.quiz_whole_snapshot_fence() from public,anon,authenticated;
do $$declare fn record;begin
  for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private') and p.proname in('quiz_whole_status','quiz_whole_open','quiz_whole_read','quiz_whole_begin','quiz_whole_part','quiz_whole_finish','quiz_whole_abort','quiz_whole_receipts','quiz_sync_v2_push','quiz_sync_v2_pull') loop
    execute format('revoke all on function %s from public, anon, authenticated',fn.signature);
    execute format('grant execute on function %s to authenticated',fn.signature);
    if exists(select 1 from pg_roles where rolname='service_role') then execute format('revoke all on function %s from service_role',fn.signature);end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on function private.quiz_sync_v2_push_record(text,jsonb),private.quiz_sync_v2_pull_record(text,bigint,integer),private.quiz_whole_snapshot_fence() from service_role;
  end if;
end $$;
