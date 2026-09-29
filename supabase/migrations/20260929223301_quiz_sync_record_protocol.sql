-- Record protocol. Snapshot RPCs remain the compatibility/bootstrap boundary.
-- The new protocol is inactive until explicitly bootstrapped by a V2 client.
create table private.quiz_sync_heads (
  sync_id text primary key references public.quiz_sync_data(sync_id) on delete cascade,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  snapshot_updated_at timestamptz not null,
  payload_bytes bigint not null default 0 check (payload_bytes >= 0)
);
create table private.quiz_sync_records (
  sync_id text not null references private.quiz_sync_heads(sync_id) on delete cascade,
  record_key text not null check (octet_length(record_key) between 1 and 2048),
  collection text not null check (collection in ('folders','problemSets','questions','progress','answerLogs','localStorage','indexedDbNotes','questionImages')),
  record_id text not null check (octet_length(record_id) between 1 and 1024),
  raw text,
  position integer not null check (position >= 0),
  revision bigint not null,
  primary key (sync_id, record_key),
  unique (sync_id, collection, record_id)
);
create table private.quiz_sync_operations (
  sync_id text not null references private.quiz_sync_heads(sync_id) on delete cascade,
  operation_id uuid not null,
  operation jsonb not null,
  revision bigint not null,
  primary key (sync_id, operation_id)
);
-- Each cursor is a whole commit. A page never cuts a deletion and its dependent
-- record changes in half, and later edits cannot hide earlier cursor events.
create table private.quiz_sync_changes (
  sync_id text not null references private.quiz_sync_heads(sync_id) on delete cascade,
  revision bigint not null,
  changes jsonb not null,
  primary key (sync_id, revision)
);
alter table private.quiz_sync_heads enable row level security;
alter table private.quiz_sync_records enable row level security;
alter table private.quiz_sync_operations enable row level security;
alter table private.quiz_sync_changes enable row level security;
revoke all on private.quiz_sync_heads, private.quiz_sync_records, private.quiz_sync_operations, private.quiz_sync_changes from public, anon, authenticated;

create function private.quiz_sync_record_key(p_collection text, p_id text)
returns text language sql immutable set search_path='' as $$
  select '[' || to_json(p_collection)::text || ',' || to_json(p_id)::text || ']'
$$;

create function private.quiz_sync_record_value_valid(p_collection text,p_id text,p_raw text)
returns boolean language plpgsql immutable set search_path='' as $$
declare value jsonb;
begin
  if p_raw is null then return true; end if;
  if p_collection in ('localStorage','indexedDbNotes') then
    return not (p_collection='localStorage' and p_id='quiz-make-app-data-v1');
  end if;
  value := p_raw::jsonb;
  return jsonb_typeof(value)='object' and coalesce(value->>(case when p_collection='progress' then 'questionId' else 'id' end)=p_id,false);
exception when invalid_text_representation then return false;
end $$;

-- Expensive only at the Snapshot boundary, never for an ordinary record push.
create function private.quiz_sync_snapshot_rows(p_payload jsonb)
returns table(record_key text,collection text,record_id text,raw text,"position" integer)
language plpgsql set search_path='' as $$
declare app jsonb; domain text;
begin
  app := (p_payload->'localStorage'->>'quiz-make-app-data-v1')::jsonb;
  if app is null or app->>'version' is distinct from '1' then raise exception 'invalid_app_snapshot'; end if;
  foreach domain in array array['folders','problemSets','questions','progress','answerLogs'] loop
    if jsonb_typeof(coalesce(app->domain,'[]'::jsonb)) <> 'array' then raise exception 'invalid_app_snapshot'; end if;
    return query select private.quiz_sync_record_key(domain, case when domain='progress' then item->>'questionId' else item->>'id' end),
      domain,case when domain='progress' then item->>'questionId' else item->>'id' end,item::text,(ordinal-1)::integer
      from jsonb_array_elements(coalesce(app->domain,'[]')) with ordinality as entries(item,ordinal);
  end loop;
  foreach domain in array array['localStorage','indexedDbNotes'] loop
    return query select private.quiz_sync_record_key(domain,entry.key),domain,entry.key,entry.value,0
      from jsonb_each_text(coalesce(p_payload->domain,'{}')) entry
      where not (domain='localStorage' and (entry.key='quiz-make-app-data-v1' or
        (entry.key like 'quizMake:image:%' and private.quiz_sync_record_value_valid('questionImages',substring(entry.key from 16),entry.value))));
  end loop;
  return query select private.quiz_sync_record_key('questionImages',substring(entry.key from 16)),
    'questionImages',substring(entry.key from 16),entry.value,0
    from jsonb_each_text(coalesce(p_payload->'localStorage','{}')) entry
    where entry.key like 'quizMake:image:%'
      and private.quiz_sync_record_value_valid('questionImages',substring(entry.key from 16),entry.value);
end $$;

create function private.quiz_sync_ingest_snapshot(p_sync_id text)
returns void language plpgsql security definer set search_path='' as $$
declare head private.quiz_sync_heads; snapshot public.quiz_sync_data; delta jsonb; next_revision bigint;
begin
  select * into head from private.quiz_sync_heads where sync_id=p_sync_id for update;
  select * into snapshot from public.quiz_sync_data where sync_id=p_sync_id;
  next_revision := head.revision+1;
  with desired as materialized (select * from private.quiz_sync_snapshot_rows(snapshot.data)),
  candidates as (
    select d.* from desired d left join private.quiz_sync_records r on r.sync_id=p_sync_id and r.record_key=d.record_key
    where r.record_key is null or r.position<>d.position or r.raw is null
      or case when d.collection in ('localStorage','indexedDbNotes') then r.raw is distinct from d.raw else r.raw::jsonb is distinct from d.raw::jsonb end
    union all
    select r.record_key,r.collection,r.record_id,null::text,r.position from private.quiz_sync_records r
      where r.sync_id=p_sync_id and r.raw is not null and not exists(select 1 from desired d where d.record_key=r.record_key)
  ), written as (
    insert into private.quiz_sync_records(sync_id,record_key,collection,record_id,raw,position,revision)
      select p_sync_id,c.record_key,c.collection,c.record_id,c.raw,c.position,next_revision from candidates c
      on conflict(sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision
      returning *
  ) select coalesce(jsonb_agg(jsonb_build_object('key',w.record_key,'collection',w.collection,'id',w.record_id,'raw',w.raw,'position',w.position,'revision',w.revision)),'[]') into delta from written w;
  if jsonb_array_length(delta)>0 then
    insert into private.quiz_sync_changes values(p_sync_id,next_revision,delta);
  else next_revision := head.revision; end if;
  update private.quiz_sync_heads set revision=next_revision,snapshot_updated_at=snapshot.updated_at,
    payload_bytes=(select coalesce(sum(octet_length(r.raw)),0) from private.quiz_sync_records r where r.sync_id=p_sync_id)
    where sync_id=p_sync_id;
end $$;

-- Legacy/manual writes still use their existing CAS, then become a record commit.
-- Operation receipts and tombstones survive these writes, including restores.
create function private.quiz_sync_snapshot_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.quiz_sync_heads where sync_id=new.sync_id) then
    perform private.quiz_sync_ingest_snapshot(new.sync_id);
  end if;
  return new;
end $$;
create trigger quiz_sync_snapshot_to_records after update of data on public.quiz_sync_data
  for each row execute function private.quiz_sync_snapshot_changed();

create function private.quiz_sync_materialize_snapshot(p_sync_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; app jsonb := '{"version":1}'; entries jsonb; domain text;
begin
  select data into result from public.quiz_sync_data where sync_id=p_sync_id;
  if not exists(select 1 from private.quiz_sync_heads where sync_id=p_sync_id) then return result; end if;
  foreach domain in array array['folders','problemSets','questions','progress','answerLogs'] loop
    select coalesce(jsonb_agg(r.raw::jsonb order by r.position,r.record_id),'[]') into entries
      from private.quiz_sync_records r where r.sync_id=p_sync_id and r.collection=domain and r.raw is not null;
    app := app || jsonb_build_object(domain,entries);
  end loop;
  foreach domain in array array['localStorage','indexedDbNotes'] loop
    select coalesce(jsonb_object_agg(r.record_id,r.raw),'{}') into entries
      from private.quiz_sync_records r where r.sync_id=p_sync_id and r.collection=domain and r.raw is not null;
    if domain='localStorage' then
      entries := entries || jsonb_build_object('quiz-make-app-data-v1',app::text);
      entries := entries || (select coalesce(jsonb_object_agg('quizMake:image:'||r.record_id,r.raw),'{}')
        from private.quiz_sync_records r where r.sync_id=p_sync_id and r.collection='questionImages' and r.raw is not null);
    end if;
    result := result || jsonb_build_object(domain,entries);
  end loop;
  return result;
end $$;

create function private.quiz_sync_v2_access(p_sync_id text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare actor bytea := private.quiz_sync_actor_hash(); snapshot_time timestamptz;
begin
  if p_sync_id is null or p_sync_id !~ '^[0-9a-f]{36}$' then
    raise exception using errcode = '22023', message = 'invalid_sync_id';
  end if;
  perform private.quiz_sync_lock_id(p_sync_id);
  select d.updated_at into snapshot_time from public.quiz_sync_data d
    where d.sync_id = p_sync_id and d.creator_hash = actor;
  if not found then raise exception using errcode = '42501', message = 'sync_not_found'; end if;
  return snapshot_time;
end $$;

create function private.quiz_sync_v2_open(p_sync_id text, p_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '10s' as $$
declare snapshot_time timestamptz; head private.quiz_sync_heads;
begin
  perform private.enforce_quiz_sync_rate_limit('record_open', 12, interval '1 minute');
  snapshot_time := private.quiz_sync_v2_access(p_sync_id);
  if p_expected_updated_at is null or snapshot_time <> p_expected_updated_at then
    return jsonb_build_object('code','conflict');
  end if;
  select * into head from private.quiz_sync_heads where sync_id = p_sync_id;
  if found then
    if head.snapshot_updated_at <> snapshot_time then return jsonb_build_object('code','snapshot_changed'); end if;
    return jsonb_build_object('code','ok','revision',head.revision);
  end if;
  -- Some pre-AppData Snapshot rows are still kept for legacy recovery. Do not
  -- bootstrap V2 from a missing AppData key; the old Snapshot client can read it.
  if (select d.data->'localStorage'->>'quiz-make-app-data-v1' from public.quiz_sync_data d where d.sync_id=p_sync_id) is null then
    return jsonb_build_object('code','legacy_snapshot');
  end if;
  insert into private.quiz_sync_heads(sync_id,snapshot_updated_at) values (p_sync_id,snapshot_time);
  perform private.quiz_sync_ingest_snapshot(p_sync_id);
  select * into head from private.quiz_sync_heads where sync_id=p_sync_id;
  return jsonb_build_object('code','ok','revision',head.revision);
end $$;

create function private.quiz_sync_v2_push(p_sync_id text, p_operations jsonb)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '10s' as $$
declare
  snapshot_time timestamptz; head private.quiz_sync_heads; op jsonb;
  previous private.quiz_sync_records; applied private.quiz_sync_operations;
  op_id uuid; v_record_key text; record_id text; domain text; raw_value text;
  base_revision bigint; ordinal integer; next_revision bigint;
  acknowledgement jsonb := '[]'; changes jsonb := '[]'; bytes_delta bigint := 0;
  remaining_bytes bigint; actor bytea := private.quiz_sync_actor_hash();
begin
  perform private.enforce_quiz_sync_rate_limit('record_push', 60, interval '1 minute');
  snapshot_time := private.quiz_sync_v2_access(p_sync_id);
  select * into head from private.quiz_sync_heads where sync_id = p_sync_id for update;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if head.snapshot_updated_at <> snapshot_time then return jsonb_build_object('code','snapshot_changed'); end if;
  if p_operations is null or jsonb_typeof(p_operations) <> 'array'
    or jsonb_array_length(p_operations) not between 1 and 500
    or octet_length(p_operations::text) > 1048576 then
    return jsonb_build_object('code','invalid');
  end if;
  if (select count(distinct x->>'operationId') from jsonb_array_elements(p_operations) x) <> jsonb_array_length(p_operations)
    or (select count(distinct x->>'key') from jsonb_array_elements(p_operations) x) <> jsonb_array_length(p_operations) then
    return jsonb_build_object('code','invalid');
  end if;
  next_revision := head.revision + 1;
  if next_revision > 9007199254740991 then return jsonb_build_object('code','revision_exhausted'); end if;
  -- First pass validates every CAS. No record is changed on a conflict.
  for op in select value from jsonb_array_elements(p_operations) loop
    if jsonb_typeof(op) <> 'object' or (op->>'operationId') is null
      or (op->>'operationId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(op->>'collection','') not in ('folders','problemSets','questions','progress','answerLogs','localStorage','indexedDbNotes','questionImages')
      or coalesce(octet_length(op->>'id'),0) not between 1 and 1024
      or coalesce(octet_length(op->>'key'),0) not between 1 and 2048
      or not (op ? 'raw') or jsonb_typeof(op->'raw') not in ('null','string')
      or coalesce(op->>'baseRevision','') !~ '^[0-9]{1,16}$'
      or coalesce(op->>'position','') !~ '^[0-9]{1,9}$' then
      return jsonb_build_object('code','invalid');
    end if;
    op_id := (op->>'operationId')::uuid; v_record_key := op->>'key';
    domain := op->>'collection'; record_id := op->>'id'; raw_value := op->>'raw';
    base_revision := (op->>'baseRevision')::bigint; ordinal := (op->>'position')::integer;
    if v_record_key <> private.quiz_sync_record_key(domain,record_id) then return jsonb_build_object('code','invalid'); end if;
    if not private.quiz_sync_record_value_valid(domain,record_id,raw_value) then return jsonb_build_object('code','invalid'); end if;
    select * into applied from private.quiz_sync_operations where sync_id = p_sync_id and operation_id = op_id;
    if found then
      if applied.operation <> op then return jsonb_build_object('code','operation_reused'); end if;
      continue;
    end if;
    select * into previous from private.quiz_sync_records where sync_id = p_sync_id and record_key = v_record_key;
    if coalesce(previous.revision,0) <> base_revision then
      return jsonb_build_object('code','conflict','key',v_record_key,'revision',coalesce(previous.revision,0));
    end if;
    bytes_delta := bytes_delta + coalesce(octet_length(raw_value),0) - coalesce(octet_length(previous.raw),0);
  end loop;
  perform private.quiz_sync_lock_quota_actor(actor);
  select coalesce(sum(d.payload_bytes),0) + coalesce((
    select sum(h.payload_bytes) from private.quiz_sync_heads h join public.quiz_sync_data d2 on d2.sync_id=h.sync_id where d2.creator_hash=actor
  ),0) into remaining_bytes from public.quiz_sync_data d where d.creator_hash=actor;
  if remaining_bytes + bytes_delta > 134217728 then return jsonb_build_object('code','quota'); end if;
  for op in select value from jsonb_array_elements(p_operations) loop
    op_id := (op->>'operationId')::uuid;
    select * into applied from private.quiz_sync_operations where sync_id = p_sync_id and operation_id = op_id;
    if found then
      acknowledgement := acknowledgement || jsonb_build_array(jsonb_build_object('operationId',op_id,'key',op->>'key','revision',applied.revision));
      continue;
    end if;
    insert into private.quiz_sync_records(sync_id,record_key,collection,record_id,raw,position,revision)
      values(p_sync_id,op->>'key',op->>'collection',op->>'id',op->>'raw',(op->>'position')::integer,next_revision)
      on conflict (sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision;
    insert into private.quiz_sync_operations values(p_sync_id,op_id,op,next_revision);
    changes := changes || jsonb_build_array(jsonb_build_object('key',op->>'key','collection',op->>'collection','id',op->>'id','raw',op->'raw','position',op->'position','revision',next_revision));
    acknowledgement := acknowledgement || jsonb_build_array(jsonb_build_object('operationId',op_id,'key',op->>'key','revision',next_revision));
  end loop;
  if jsonb_array_length(changes) > 0 then
    insert into private.quiz_sync_changes values(p_sync_id,next_revision,changes);
    snapshot_time := greatest(clock_timestamp(),snapshot_time+interval '1 microsecond');
    -- Only small metadata changes; the old JSON is retained as a recovery copy.
    update public.quiz_sync_data set updated_at=snapshot_time,last_accessed_at=snapshot_time where sync_id=p_sync_id;
    update private.quiz_sync_heads set revision=next_revision,payload_bytes=payload_bytes+bytes_delta,snapshot_updated_at=snapshot_time where sync_id=p_sync_id;
  else next_revision := head.revision; end if;
  return jsonb_build_object('code','ok','revision',next_revision,'ack',acknowledgement);
end $$;

-- Full reconstruction is reserved for old clients, initial pairing and recovery.
create or replace function public.quiz_sync_read(p_sync_id text)
returns table(sync_id text,data jsonb,updated_at timestamptz)
language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare actor bytea := private.quiz_sync_actor_hash();
begin
  perform private.enforce_quiz_sync_rate_limit('read',30,interval '1 minute');
  if p_sync_id is null or p_sync_id !~ '^[0-9a-f]{36}$' then return; end if;
  perform private.quiz_sync_lock_id(p_sync_id);
  update public.quiz_sync_data d set creator_hash=actor where d.sync_id=p_sync_id and d.creator_hash is null;
  update public.quiz_sync_data d set last_accessed_at=clock_timestamp()
    where d.sync_id=p_sync_id and d.creator_hash=actor and d.last_accessed_at<clock_timestamp()-interval '1 day';
  return query select d.sync_id,private.quiz_sync_materialize_snapshot(d.sync_id),d.updated_at
    from public.quiz_sync_data d where d.sync_id=p_sync_id and d.creator_hash=actor;
end $$;
revoke all on function public.quiz_sync_read(text) from public,anon;
grant execute on function public.quiz_sync_read(text) to authenticated;

revoke all on function private.quiz_sync_record_key(text,text),private.quiz_sync_snapshot_rows(jsonb),
  private.quiz_sync_record_value_valid(text,text,text),private.quiz_sync_ingest_snapshot(text),private.quiz_sync_snapshot_changed(),private.quiz_sync_materialize_snapshot(text) from public,anon,authenticated;

create function private.quiz_sync_v2_pull(p_sync_id text, p_cursor bigint, p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '10s' as $$
declare snapshot_time timestamptz; head private.quiz_sync_heads; batches jsonb; next_cursor bigint;
begin
  perform private.enforce_quiz_sync_rate_limit('record_pull', 120, interval '1 minute');
  snapshot_time := private.quiz_sync_v2_access(p_sync_id);
  select * into head from private.quiz_sync_heads where sync_id=p_sync_id;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if head.snapshot_updated_at <> snapshot_time then return jsonb_build_object('code','snapshot_changed'); end if;
  if p_cursor is null or p_cursor < 0 or p_cursor > head.revision or p_limit is null or p_limit not between 1 and 20 then
    return jsonb_build_object('code','invalid_cursor');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('revision',c.revision,'changes',c.changes) order by c.revision),'[]'),coalesce(max(c.revision),p_cursor)
    into batches,next_cursor from (select revision,changes from private.quiz_sync_changes where sync_id=p_sync_id and revision>p_cursor order by revision limit p_limit) c;
  return jsonb_build_object('code','ok','cursor',next_cursor,'head',head.revision,'batches',batches,'hasMore',next_cursor<head.revision);
end $$;

revoke all on function private.quiz_sync_v2_access(text) from public,anon,authenticated;
revoke all on function private.quiz_sync_v2_open(text,timestamptz), private.quiz_sync_v2_push(text,jsonb), private.quiz_sync_v2_pull(text,bigint,integer) from public,anon,authenticated;
grant usage on schema private to authenticated;
grant execute on function private.quiz_sync_v2_open(text,timestamptz), private.quiz_sync_v2_push(text,jsonb), private.quiz_sync_v2_pull(text,bigint,integer) to authenticated;
create function public.quiz_sync_v2_open(p_sync_id text,p_expected_updated_at timestamptz)
returns jsonb language sql security invoker set search_path='' as $$ select private.quiz_sync_v2_open(p_sync_id,p_expected_updated_at) $$;
create function public.quiz_sync_v2_push(p_sync_id text,p_operations jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.quiz_sync_v2_push(p_sync_id,p_operations) $$;
create function public.quiz_sync_v2_pull(p_sync_id text,p_cursor bigint,p_limit integer default 10)
returns jsonb language sql security invoker set search_path='' as $$ select private.quiz_sync_v2_pull(p_sync_id,p_cursor,p_limit) $$;
revoke all on function public.quiz_sync_v2_open(text,timestamptz), public.quiz_sync_v2_push(text,jsonb), public.quiz_sync_v2_pull(text,bigint,integer) from public,anon,authenticated;
grant execute on function public.quiz_sync_v2_open(text,timestamptz), public.quiz_sync_v2_push(text,jsonb), public.quiz_sync_v2_pull(text,bigint,integer) to authenticated;
