-- Decode each staged part once. Repeatedly scanning a combined JSON document
-- for every existing record made large whole replacements time out.
-- CREATE OR REPLACE preserves the existing owner and execute privileges.
do $$ begin
  if to_regprocedure('private.quiz_whole_finish(text,uuid)') is null then
    raise exception 'whole_finish_not_initialized';
  end if;
end $$;

create or replace function private.quiz_whole_finish(p_sync_id text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare
  h private.quiz_sync_heads; c private.quiz_sync_operations;
  incoming private.quiz_sync_records[]; incoming_keys text[];
  part_count integer; row_count integer; unique_count integer;
  actual_digest text; total_bytes bigint; account_bytes bigint;
  next_revision bigint; saved_at timestamptz;
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
  select coalesce(array_agg(row(p_sync_id,x.key,x.collection,x.id,x.raw,x.position,0)::private.quiz_sync_records),'{}'::private.quiz_sync_records[]),
      coalesce(array_agg(x.key),'{}'::text[]),count(*),count(distinct x.key),coalesce(sum(octet_length(x.raw)),0)
    into incoming,incoming_keys,row_count,unique_count,total_bytes
    from private.quiz_sync_operations o
    cross join lateral jsonb_to_recordset((o.operation->>'raw')::jsonb) as x(key text,collection text,id text,raw text,position integer)
    where o.sync_id=p_sync_id and o.operation->>'kind'='whole-part' and o.operation->>'commitId'=p_operation_id::text;
  if row_count<>(c.operation->>'records')::integer or unique_count<>row_count then return jsonb_build_object('code','invalid');end if;
  if not (c.operation->>'replace')::boolean then
    select h.payload_bytes+coalesce(sum(coalesce(octet_length(x.raw),0)-coalesce(octet_length(r.raw),0)),0) into total_bytes
      from unnest(incoming) x left join private.quiz_sync_records r on r.sync_id=p_sync_id and r.record_key=x.record_key;
  end if;
  perform private.quiz_sync_lock_quota_actor(private.quiz_sync_actor_hash());
  select coalesce(sum(d.payload_bytes),0)+coalesce((select sum(head.payload_bytes) from private.quiz_sync_heads head join public.quiz_sync_data ds on ds.sync_id=head.sync_id where ds.creator_hash=private.quiz_sync_actor_hash() and head.sync_id<>p_sync_id),0) into account_bytes
    from public.quiz_sync_data d where d.creator_hash=private.quiz_sync_actor_hash();
  if account_bytes+total_bytes>134217728 then return jsonb_build_object('code','quota');end if;
  next_revision:=h.revision+1;if next_revision>9007199254740991 then return jsonb_build_object('code','revision_exhausted');end if;
  -- Compare lightweight keys as a set instead of rescanning the whole payload.
  if (c.operation->>'replace')::boolean then
    with omitted as (
      select r.record_key from private.quiz_sync_records r where r.sync_id=p_sync_id and r.raw is not null
      except select k.record_key from unnest(incoming_keys) as k(record_key)
    )
    update private.quiz_sync_records r set raw=null,revision=next_revision
      from omitted o where r.sync_id=p_sync_id and r.record_key=o.record_key;
  end if;
  insert into private.quiz_sync_records(sync_id,record_key,collection,record_id,raw,position,revision)
    select p_sync_id,x.record_key,x.collection,x.record_id,x.raw,x.position,next_revision from unnest(incoming) x
    on conflict(sync_id,record_key) do update set raw=excluded.raw,position=excluded.position,revision=excluded.revision;
  saved_at:=greatest(clock_timestamp(),h.snapshot_updated_at+interval '1 microsecond');
  update public.quiz_sync_data set updated_at=saved_at,last_accessed_at=saved_at where sync_id=p_sync_id;
  update private.quiz_sync_heads set revision=next_revision,payload_bytes=total_bytes,snapshot_updated_at=saved_at,whole_device=c.operation->>'device',whole_saved_at=saved_at where sync_id=p_sync_id;
  update private.quiz_sync_operations set operation=operation||jsonb_build_object('state','committed'),revision=next_revision where sync_id=p_sync_id and operation_id=p_operation_id;
  delete from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-part' and operation->>'commitId'=p_operation_id::text;
  return jsonb_build_object('code','ok','revision',next_revision);
end $$;
