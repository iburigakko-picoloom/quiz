-- V3 keeps the existing canonical records and all legacy receipts in place.
-- Activation is a checked writer fence, never a destructive copy/restore.
set local lock_timeout = '2s';
alter table private.quiz_sync_heads add column delta_enabled boolean not null default false;
alter table private.quiz_sync_heads add column delta_base bigint;
create table private.quiz_delta_receipts (
  sync_id text not null references private.quiz_sync_heads on delete cascade,
  operation_id uuid not null, device_id uuid not null, device_sequence bigint not null check(device_sequence>0),
  parts integer not null check(parts between 1 and 4096), digest text not null,
  revision bigint, created_at timestamptz not null default clock_timestamp(),
  primary key(sync_id,operation_id), unique(sync_id,device_id,device_sequence)
);
create table private.quiz_delta_parts (
  sync_id text not null, operation_id uuid not null, part integer not null, payload text not null,
  primary key(sync_id,operation_id,part), foreign key(sync_id,operation_id) references private.quiz_delta_receipts on delete cascade
);
create table private.quiz_delta_log (
  sync_id text not null references private.quiz_sync_heads on delete cascade,
  revision bigint not null, payload text not null, primary key(sync_id,revision)
);
create table private.quiz_delta_history (
  sync_id text not null references private.quiz_sync_heads on delete cascade,
  record_key text not null, revision bigint not null, raw text, position integer not null,
  primary key(sync_id,record_key,revision)
);
create table private.quiz_delta_rescues (
  sync_id text not null references private.quiz_sync_heads on delete cascade, operation_id uuid not null,
  record_key text not null, raw text not null, position integer not null, primary key(sync_id,operation_id,record_key)
);
alter table private.quiz_delta_receipts enable row level security;
alter table private.quiz_delta_parts enable row level security;
alter table private.quiz_delta_log enable row level security;
alter table private.quiz_delta_history enable row level security;
alter table private.quiz_delta_rescues enable row level security;
revoke all on private.quiz_delta_receipts,private.quiz_delta_parts,private.quiz_delta_log,private.quiz_delta_history,private.quiz_delta_rescues from public,anon,authenticated;

create function private.quiz_delta_parent(p_collection text,p_id text,p_raw text) returns text language sql immutable set search_path='' as $$
  select case p_collection
    when 'folders' then case when p_raw::jsonb->>'parentId' is not null then private.quiz_sync_record_key('folders',p_raw::jsonb->>'parentId') end
    when 'problemSets' then private.quiz_sync_record_key('folders',p_raw::jsonb->>'folderId')
    when 'questions' then private.quiz_sync_record_key('problemSets',p_raw::jsonb->>'setId')
    when 'progress' then private.quiz_sync_record_key('questions',p_raw::jsonb->>'questionId')
    when 'answerLogs' then private.quiz_sync_record_key('questions',p_raw::jsonb->>'questionId')
    when 'questionImages' then private.quiz_sync_record_key('questions',p_raw::jsonb->>'questionId')
    when 'indexedDbNotes' then case when starts_with(p_id,'quizMake:notes:') then private.quiz_sync_record_key('problemSets',split_part(p_id,':',3)) end
  end
$$;

create function private.quiz_delta_fence() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.quiz_sync_heads where sync_id=coalesce(new.sync_id,old.sync_id) and delta_enabled)
    and current_setting('quiz.delta_writer',true) is distinct from coalesce(new.sync_id,old.sync_id) then
    raise exception using errcode='55000',message='update_required';
  end if;
  return coalesce(new,old);
end $$;
create trigger quiz_delta_record_fence before insert or update or delete on private.quiz_sync_records for each row execute function private.quiz_delta_fence();
create trigger quiz_delta_snapshot_fence before update of data on public.quiz_sync_data for each row execute function private.quiz_delta_fence();

-- Progress is advanced from immutable answer events, never replaced by a
-- competing device's counter. Legacy progress is the initial accumulator.
create function private.quiz_delta_answer(p jsonb,a jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare n integer:=coalesce((p->>'answeredCount')::integer,0); level integer:=coalesce((p->>'reviewLevel')::integer,0);
  correct boolean:=(a->>'isCorrect')::boolean; days integer; due boolean; result jsonb;
begin
  if coalesce((p->>'isGraduated')::boolean,false) then level:=4; end if;
  result:=coalesce(p,'{}')||jsonb_build_object('questionId',a->>'questionId','answeredCount',n+1,
    'correctCount',coalesce((p->>'correctCount')::integer,0)+case when correct then 1 else 0 end,
    'wrongCount',coalesce((p->>'wrongCount')::integer,0)+case when correct then 0 else 1 end,
    'lastSelectedIndex',(a->>'selectedIndex')::integer,'lastAnswerCorrect',correct,'lastAnsweredAt',a->>'answeredAt',
    'isAmbiguous',coalesce((p->>'isAmbiguous')::boolean,false));
  days:=case when p->>'lastAnswerCorrect'='false' or p->>'isAmbiguous'='true' then 1 when level=3 then 7 when level=2 then 3 else 1 end;
  -- Dates are carried by the answer's recorded study timezone, not the server timezone.
  due:=coalesce(((a->>'answeredAt')::timestamptz at time zone coalesce(a->>'studyTimeZone','Asia/Tokyo'))::date >=
    ((p->>'lastAnsweredAt')::timestamptz at time zone coalesce(a->>'studyTimeZone','Asia/Tokyo'))::date + days,true);
  if n=0 then result:=result||'{"isReview":true,"isGraduated":false,"reviewLevel":1}'::jsonb;
  elsif p->>'isGraduated'='true' and correct then null;
  elsif correct and (p->>'isReview'='true' or p->>'isAmbiguous'='true') and p->>'isGraduated' is distinct from 'true' and not due then
    result:=result||jsonb_build_object('reviewLevel',greatest(1,level));
  elsif correct and level>=3 then result:=result||'{"isReview":false,"isGraduated":true,"reviewLevel":null}'::jsonb;
  else result:=result||jsonb_build_object('isReview',true,'isGraduated',false,'reviewLevel',case when correct then level+1 else greatest(1,level-1) end);
  end if;
  return result;
end $$;

create function private.quiz_delta_sync(p_sync_id text,p_action text,p_request jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare h private.quiz_sync_heads; receipt private.quiz_delta_receipts; op uuid; device uuid; sequence bigint;
  v_part integer; parts integer; payload text; items jsonb; item jsonb; previous private.quiz_sync_records;
  rev bigint; changes text[]:='{}'; row_value jsonb; raw_value text; delta_bytes bigint:=0; account_bytes bigint;
  key_value text; prior_text text; after_key text; offset_value integer; text_value text; fragment text;
  rows_value jsonb:='[]'; bytes_value integer:=0; next_offset integer; finished boolean; enabled boolean;
  qid text; prog jsonb; event jsonb; touched text[]:='{}'; parent_deleted boolean; cascaded boolean;
begin
  perform private.quiz_sync_v2_access(p_sync_id);
  select * into h from private.quiz_sync_heads where sync_id=p_sync_id for update;
  if not found then return jsonb_build_object('code','not_initialized'); end if;
  if p_action='status' then return jsonb_build_object('code','ok','enabled',h.delta_enabled,'revision',h.revision,'base',h.delta_base,'version',3,
    'sequence',(select coalesce(max(device_sequence),0) from private.quiz_delta_receipts where sync_id=p_sync_id and device_id::text=p_request->>'deviceId')); end if;
  if p_action='enable' then
    if h.delta_enabled then return jsonb_build_object('code','ok','revision',h.revision,'base',h.delta_base); end if;
    if coalesce(p_request->>'revision','') !~ '^[0-9]{1,16}$' or h.revision<>(p_request->>'revision')::bigint then return jsonb_build_object('code','conflict'); end if;
    -- The same owner/stream lock serializes legacy finish and this fence. Any
    -- unfinished legacy staging becomes definitively uncommitted here; keep its
    -- exact parts until its device resolves them through abort/receipt lookup.
    -- Same table, keys, values, tombstones and revisions. No migration can lose a row.
    update private.quiz_sync_heads set delta_enabled=true,delta_base=revision where sync_id=p_sync_id;
    return jsonb_build_object('code','ok','revision',h.revision,'base',h.revision);
  end if;
  if not h.delta_enabled and p_action<>'checkpoint' then return jsonb_build_object('code','not_enabled'); end if;
  if p_action='receipt' then
    select * into receipt from private.quiz_delta_receipts where sync_id=p_sync_id and operation_id=(p_request->>'operationId')::uuid;
    return jsonb_build_object('code','ok','state',case when not found then 'absent' when receipt.revision is null then 'staging' else 'committed' end,'revision',receipt.revision);
  end if;
  if p_action='history' then
    return jsonb_build_object('code','ok','versions',(select coalesce(jsonb_agg(to_jsonb(r) - 'sync_id'),'[]') from private.quiz_delta_history r where sync_id=p_sync_id and record_key=p_request->>'key'),
      'rescues',(select coalesce(jsonb_agg(to_jsonb(r) - 'sync_id'),'[]') from private.quiz_delta_rescues r where sync_id=p_sync_id and record_key=p_request->>'key'));
  end if;
  if p_action='pull' then
    perform private.enforce_quiz_sync_rate_limit('delta_pull',180,interval '1 minute');
    rev:=coalesce((p_request->>'revision')::bigint,h.delta_base); offset_value:=coalesce((p_request->>'offset')::integer,0);
    if rev<h.delta_base then return jsonb_build_object('code','checkpoint_required','revision',h.revision); end if;
    if offset_value>0 and not exists(select 1 from private.quiz_delta_log where sync_id=p_sync_id and revision=rev) then return jsonb_build_object('code','checkpoint_required','revision',h.revision); end if;
    if offset_value=0 then select l.revision,l.payload into rev,text_value from private.quiz_delta_log l where sync_id=p_sync_id and l.revision>rev order by l.revision limit 1;
    else select l.payload into text_value from private.quiz_delta_log l where sync_id=p_sync_id and l.revision=rev; end if;
    if text_value is null then
      if offset_value>0 then return jsonb_build_object('code','checkpoint_required','revision',h.revision); end if;
      return jsonb_build_object('code','ok','revision',h.revision,'offset',0,'fragment','','complete',true,'head',h.revision);
    end if;
    if offset_value<0 or offset_value>length(text_value) then return jsonb_build_object('code','invalid'); end if;
    -- 32K Unicode characters allow JSON escaping and stay below 256 KiB.
    fragment:=substring(text_value from offset_value+1 for 32768); next_offset:=offset_value+length(fragment); finished:=next_offset=length(text_value);
    return jsonb_build_object('code','ok','revision',rev,'offset',case when finished then 0 else next_offset end,'fragment',fragment,'complete',finished,'head',h.revision);
  end if;
  if p_action='checkpoint' then
    rev:=coalesce((p_request->>'revision')::bigint,h.revision);
    if rev<>h.revision then return jsonb_build_object('code','conflict','revision',h.revision); end if;
    after_key:=coalesce(p_request->>'after',''); offset_value:=coalesce((p_request->>'offset')::integer,0);
    for previous in select * from private.quiz_sync_records where sync_id=p_sync_id and (record_key>after_key or (record_key=after_key and offset_value>0)) order by record_key limit 200 loop
      text_value:=jsonb_build_object('key',previous.record_key,'collection',previous.collection,'id',previous.record_id,'raw',previous.raw,'position',previous.position,'revision',previous.revision)::text;
      fragment:=substring(text_value from offset_value+1 for 32768); next_offset:=offset_value+length(fragment); finished:=next_offset=length(text_value);
      row_value:=jsonb_build_object('key',previous.record_key,'fragment',fragment,'complete',finished);
      if bytes_value+octet_length(row_value::text)>245760 then exit; end if;
      rows_value:=rows_value||jsonb_build_array(row_value); bytes_value:=bytes_value+octet_length(row_value::text);
      after_key:=previous.record_key; offset_value:=case when finished then 0 else next_offset end;
      if not finished then exit; end if;
    end loop;
    return jsonb_build_object('code','ok','revision',rev,'after',after_key,'offset',offset_value,'rows',rows_value,'complete',offset_value=0 and not exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and record_key>after_key));
  end if;
  if p_action<>'push' then return jsonb_build_object('code','invalid'); end if;
  perform private.enforce_quiz_sync_rate_limit('delta_push',180,interval '1 minute');
  op:=(p_request->>'operationId')::uuid;device:=(p_request->>'deviceId')::uuid;sequence:=(p_request->>'sequence')::bigint;
  v_part:=(p_request->>'part')::integer;parts:=(p_request->>'parts')::integer;payload:=p_request->>'payload';
  if op is null or device is null or sequence is null or sequence<1 or v_part is null or parts is null or parts not between 1 and 4096 or v_part not between 0 and parts-1 or payload is null or octet_length(payload)>245760 or coalesce(p_request->>'digest','') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('code','invalid'); end if;
  select * into receipt from private.quiz_delta_receipts where sync_id=p_sync_id and operation_id=op;
  if found then
    if receipt.device_id<>device or receipt.device_sequence<>sequence or receipt.parts<>parts or receipt.digest<>p_request->>'digest' then return jsonb_build_object('code','operation_reused'); end if;
    if receipt.revision is not null then return jsonb_build_object('code','ok','state','committed','revision',receipt.revision); end if;
  else
    if exists(select 1 from private.quiz_delta_receipts where sync_id=p_sync_id and device_id=device and device_sequence=sequence) then return jsonb_build_object('code','operation_reused'); end if;
    insert into private.quiz_delta_receipts(sync_id,operation_id,device_id,device_sequence,parts,digest) values(p_sync_id,op,device,sequence,parts,p_request->>'digest');
  end if;
  select p.payload into prior_text from private.quiz_delta_parts p where sync_id=p_sync_id and operation_id=op and p.part=v_part;
  if found and prior_text<>payload then return jsonb_build_object('code','operation_reused'); end if;
  insert into private.quiz_delta_parts values(p_sync_id,op,v_part,payload) on conflict do nothing;
  if (select count(*) from private.quiz_delta_parts where sync_id=p_sync_id and operation_id=op)<parts then return jsonb_build_object('code','ok','state','staging'); end if;
  select string_agg(p.payload,'' order by p.part) into payload from private.quiz_delta_parts p where sync_id=p_sync_id and operation_id=op;
  if octet_length(payload)>67108864 or encode(sha256(convert_to(payload,'UTF8')),'hex')<>p_request->>'digest' then return jsonb_build_object('code','invalid'); end if;
  items:=payload::jsonb;
  if jsonb_typeof(items)<>'array' or jsonb_array_length(items) not between 1 and 200000 or (select count(distinct v->>'key') from jsonb_array_elements(items)v)<>jsonb_array_length(items) then return jsonb_build_object('code','invalid'); end if;
  for item in select value from jsonb_array_elements(items) loop
    if coalesce(item->>'collection','') not in ('folders','problemSets','questions','progress','answerLogs','localStorage','indexedDbNotes','questionImages')
      or coalesce(octet_length(item->>'id'),0) not between 1 and 1024 or item->>'key' is distinct from private.quiz_sync_record_key(item->>'collection',item->>'id')
      or not(item?'raw') or jsonb_typeof(item->'raw') not in ('string','null') or coalesce(item->>'position','') !~ '^[0-9]{1,9}$'
      or not private.quiz_sync_record_value_valid(item->>'collection',item->>'id',item->>'raw') then return jsonb_build_object('code','invalid'); end if;
  end loop;
  rev:=h.revision+1;
  perform set_config('quiz.delta_writer',p_sync_id,true);
  -- Archive differing values before applying one atomic operation. The immutable
  -- log and staging receipts independently protect in-flight dependencies.
  for item in select value from jsonb_array_elements(items) order by (value->>'localRevision')::bigint,value->>'key' loop
    key_value:=item->>'key';raw_value:=item->>'raw';
    select * into previous from private.quiz_sync_records where sync_id=p_sync_id and record_key=key_value;
    -- A representation-only migration is never a new edit. A newer cloud edit
    -- wins even when the conversion finished later on another device.
    if item->>'representationOnly'='true' and coalesce(previous.revision,0)<>coalesce((item->>'baseRevision')::bigint,0) then continue; end if;
    if item->>'collection'='progress' and exists(select 1 from jsonb_array_elements(items) v where v->>'collection'='localStorage' and starts_with(v->>'id','quizMake:sync-event:') and (v->>'raw')::jsonb->>'questionId'=item->>'id') then continue; end if;
    if item->>'collection'='localStorage' and starts_with(item->>'id','quizMake:sync-event:') then
      if previous.record_key is not null then continue; end if;
      touched:=array_append(touched,key_value);
    end if;
    -- Answer IDs are immutable. A duplicate from another device cannot count twice.
    if item->>'collection'='answerLogs' and previous.raw is not null and raw_value is not null then continue; end if;
    if previous.raw is not distinct from raw_value and previous.position=(item->>'position')::integer then continue; end if;
    if previous.record_key is not null and previous.raw is distinct from raw_value then
      delete from private.quiz_delta_history where sync_id=p_sync_id and record_key=key_value and (raw is not distinct from raw_value or raw is not distinct from previous.raw);
      insert into private.quiz_delta_history values(p_sync_id,key_value,rev,previous.raw,previous.position) on conflict do nothing;
      delete from private.quiz_delta_history x where x.sync_id=p_sync_id and x.record_key=key_value and x.revision not in(select y.revision from private.quiz_delta_history y where y.sync_id=p_sync_id and y.record_key=key_value order by y.revision desc limit 2);
    end if;
    delta_bytes:=delta_bytes+coalesce(octet_length(raw_value),0)-coalesce(octet_length(previous.raw),0);
    insert into private.quiz_sync_records values(p_sync_id,key_value,item->>'collection',item->>'id',raw_value,(item->>'position')::integer,rev)
      on conflict(sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision;
    changes:=array_append(changes,(item-'operationId'-'baseContent'-'baseRevision'-'localRevision'||jsonb_build_object('revision',rev))::text);
  end loop;
  parent_deleted:=exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and revision=rev and raw is null and collection in('folders','problemSets','questions'));
  loop
    cascaded:=false;
    for previous in select r.* from private.quiz_sync_records r join private.quiz_sync_records p
      on p.sync_id=r.sync_id and p.record_key=private.quiz_delta_parent(r.collection,r.record_id,r.raw) and p.raw is null
      where r.sync_id=p_sync_id and r.raw is not null and (parent_deleted or r.revision=rev) loop
      insert into private.quiz_delta_rescues values(p_sync_id,op,previous.record_key,previous.raw,previous.position) on conflict do nothing;
      delta_bytes:=delta_bytes-octet_length(previous.raw);
      update private.quiz_sync_records set raw=null,revision=rev where sync_id=p_sync_id and record_key=previous.record_key;
      changes:=array_append(changes,jsonb_build_object('key',previous.record_key,'collection',previous.collection,'id',previous.record_id,'raw',null,'position',previous.position,'revision',rev)::text);
      cascaded:=true;parent_deleted:=true;
    end loop;
    exit when not cascaded;
  end loop;
  foreach key_value in array touched loop
    select raw::jsonb into event from private.quiz_sync_records where sync_id=p_sync_id and record_key=key_value;
    qid:=event->>'questionId';
    if not exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and collection='questions' and record_id=qid and raw is not null) then continue; end if;
    select * into previous from private.quiz_sync_records where sync_id=p_sync_id and collection='progress' and record_id=qid;
    prog:=coalesce(previous.raw::jsonb,jsonb_build_object('questionId',qid,'answeredCount',0,'correctCount',0,'wrongCount',0,'lastSelectedIndex',null,'lastAnswerCorrect',null,'lastAnsweredAt',null,'isReview',false,'isAmbiguous',false,'reviewLevel',null,'isGraduated',false));
    if event->>'action'='answer' then
      -- Only the first committed copy of this answer ID advances progress.
      if not exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and collection='answerLogs' and record_id=event->'answer'->>'id' and revision=rev and raw is not null) then continue; end if;
      if exists(select 1 from private.quiz_sync_records where sync_id=p_sync_id and collection='localStorage' and record_id='quizMake:answer-applied:'||(event->'answer'->>'id')) then continue; end if;
      prog:=private.quiz_delta_answer(prog,event->'answer');
      insert into private.quiz_sync_records values(p_sync_id,private.quiz_sync_record_key('localStorage','quizMake:answer-applied:'||(event->'answer'->>'id')),'localStorage','quizMake:answer-applied:'||(event->'answer'->>'id'),'1',0,rev);
      delta_bytes:=delta_bytes+1;
    elsif event->>'action'='reset' then prog:=event->'value';
    elsif event->>'action'='initialize' and previous.raw is null then prog:=event->'value';
    elsif event->>'action'='patch' then
      select prog||coalesce(jsonb_object_agg(e.key,e.value),'{}') into prog from jsonb_each(event->'patch')e where e.key in('isReview','isAmbiguous','reviewLevel','isGraduated','isStudyCompleted');
    end if;
    if prog->>'questionId' is distinct from qid then raise exception 'invalid_learning_event'; end if;
    key_value:=private.quiz_sync_record_key('progress',qid);
    if previous.raw is not null and previous.raw::jsonb<>prog then
      delete from private.quiz_delta_history where sync_id=p_sync_id and record_key=key_value and (raw::jsonb=prog or raw=previous.raw);
      insert into private.quiz_delta_history values(p_sync_id,key_value,rev,previous.raw,previous.position) on conflict do nothing;
    end if;
    delta_bytes:=delta_bytes+octet_length(prog::text)-coalesce(octet_length(previous.raw),0);
    insert into private.quiz_sync_records values(p_sync_id,key_value,'progress',qid,prog::text,coalesce(previous.position,0),rev) on conflict(sync_id,record_key) do update set raw=excluded.raw,revision=excluded.revision;
    changes:=array_append(changes,jsonb_build_object('key',key_value,'collection','progress','id',qid,'raw',prog::text,'position',coalesce(previous.position,0),'revision',rev)::text);
    delete from private.quiz_delta_history x where x.sync_id=p_sync_id and x.record_key=key_value and x.revision not in(select y.revision from private.quiz_delta_history y where y.sync_id=p_sync_id and y.record_key=key_value order by y.revision desc limit 2);
  end loop;
  -- Validate references after all members of the operation have been applied.
  -- A rejected transaction keeps both the sender's frozen bytes and server parts.
  if exists(select 1 from private.quiz_sync_records r where r.sync_id=p_sync_id and r.raw is not null and r.revision=rev and
    ((r.collection='problemSets' and not exists(select 1 from private.quiz_sync_records p where p.sync_id=p_sync_id and p.collection='folders' and p.record_id=r.raw::jsonb->>'folderId' and p.raw is not null))
    or (r.collection='questions' and not exists(select 1 from private.quiz_sync_records p where p.sync_id=p_sync_id and p.collection='problemSets' and p.record_id=r.raw::jsonb->>'setId' and p.raw is not null))
    or (r.collection in ('progress','answerLogs') and not exists(select 1 from private.quiz_sync_records p where p.sync_id=p_sync_id and p.collection='questions' and p.record_id=r.raw::jsonb->>'questionId' and p.raw is not null)))) then raise exception 'delta_dependency_missing'; end if;
  if h.payload_bytes+delta_bytes>134217728 then raise exception 'delta_quota'; end if;
  select coalesce(sum(d.payload_bytes),0)+coalesce((select sum(head.payload_bytes) from private.quiz_sync_heads head join public.quiz_sync_data ds on ds.sync_id=head.sync_id where ds.creator_hash=private.quiz_sync_actor_hash() and head.sync_id<>p_sync_id),0) into account_bytes
    from public.quiz_sync_data d where d.creator_hash=private.quiz_sync_actor_hash();
  if account_bytes+h.payload_bytes+delta_bytes>536870912 then raise exception 'delta_account_quota'; end if;
  insert into private.quiz_delta_log values(p_sync_id,rev,'['||array_to_string(changes,',')||']');
  update private.quiz_sync_heads set revision=rev,payload_bytes=payload_bytes+delta_bytes where sync_id=p_sync_id;
  -- Retain 10,000 complete operations; older devices use a pinned checkpoint.
  -- Receipts and rescue originals are independent and never evicted here.
  if rev-coalesce(h.delta_base,0)>10000 then
    delete from private.quiz_delta_log where sync_id=p_sync_id and revision<=rev-10000;
    update private.quiz_sync_heads set delta_base=rev-10000 where sync_id=p_sync_id;
  end if;
  update public.quiz_sync_data set updated_at=clock_timestamp() where sync_id=p_sync_id;
  update private.quiz_delta_receipts set revision=rev where sync_id=p_sync_id and operation_id=op;
  -- Keep compact immutable receipt; request digest verifies retries without body copies.
  delete from private.quiz_delta_parts where sync_id=p_sync_id and operation_id=op;
  return jsonb_build_object('code','ok','state','committed','revision',rev);
end $$;
create function public.quiz_delta_sync(p_sync_id text,p_action text,p_request jsonb default '{}') returns jsonb language sql security invoker set search_path='' set statement_timeout='30s' as $$ select private.quiz_delta_sync(p_sync_id,p_action,p_request) $$;
revoke all on function private.quiz_delta_fence(),private.quiz_delta_parent(text,text,text),private.quiz_delta_answer(jsonb,jsonb),private.quiz_delta_sync(text,text,jsonb),public.quiz_delta_sync(text,text,jsonb) from public,anon;
revoke all on function private.quiz_delta_fence(),private.quiz_delta_parent(text,text,text),private.quiz_delta_answer(jsonb,jsonb) from authenticated;
grant execute on function private.quiz_delta_sync(text,text,jsonb),public.quiz_delta_sync(text,text,jsonb) to authenticated;
-- Fence even a no-op legacy finish: row triggers alone cannot catch a request
-- that only updates the head/receipt. Reads and receipt/abort resolution remain.
do $fence$
declare fn record; args text; legacy text;
begin
  for fn in select p.oid,p.proname,p.proargnames,p.pronargs,pg_get_function_identity_arguments(p.oid) identity_args,
      pg_get_function_arguments(p.oid) declaration
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname in ('quiz_whole_open','quiz_whole_begin','quiz_whole_part','quiz_whole_finish','quiz_whole_commit','quiz_sync_v2_open','quiz_sync_v2_push','quiz_sync_v2_pull') loop
    legacy:=fn.proname||'_before_delta';
    select string_agg(quote_ident(name),',' order by ord) into args from unnest(fn.proargnames[1:fn.pronargs]) with ordinality as a(name,ord);
    execute format('alter function private.%I(%s) rename to %I',fn.proname,fn.identity_args,legacy);
    execute format('create function private.%I(%s) returns jsonb language plpgsql security definer set search_path='''' as $body$ begin
      perform private.quiz_sync_v2_access(p_sync_id);
      if exists(select 1 from private.quiz_sync_heads where sync_id=p_sync_id and delta_enabled) then return jsonb_build_object(''code'',''update_required''); end if;
      return private.%I(%s); end $body$',fn.proname,fn.declaration,legacy,args);
    execute format('revoke all on function private.%I(%s) from public,anon,authenticated',legacy,fn.identity_args);
    execute format('revoke all on function private.%I(%s) from public,anon',fn.proname,fn.identity_args);
    execute format('grant execute on function private.%I(%s) to authenticated',fn.proname,fn.identity_args);
  end loop;
end $fence$;
notify pgrst,'reload schema';
