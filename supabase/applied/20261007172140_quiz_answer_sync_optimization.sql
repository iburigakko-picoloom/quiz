-- Match the exact live-row predicate and bytewise pagination used by whole_read.
set local lock_timeout = '2s';
set local statement_timeout = '60s';
do $preflight$
begin
  if to_regprocedure('private.quiz_whole_begin(text,uuid,bigint,integer,integer,text,text,boolean)') is null
    or to_regprocedure('private.quiz_whole_part(text,uuid,uuid,integer,text)') is null
    or to_regprocedure('private.quiz_whole_finish(text,uuid)') is null then
    raise exception 'Whole sync must already be installed';
  end if;
end $preflight$;
create index quiz_sync_records_live_key_c_idx
  on private.quiz_sync_records (sync_id, record_key collate "C") where raw is not null;

-- Small deltas use the same manifest, byte hashes, operation receipts and head
-- CAS as multipart uploads. All three existing steps run in one transaction.
-- A returned failure rolls back staging as well as live writes. Large/replace
-- uploads continue using the existing durable multipart protocol.
create function private.quiz_whole_commit(
  p_sync_id text, p_operation_id uuid, p_expected_revision bigint, p_records integer,
  p_digest text, p_device text, p_part_id uuid, p_raw text
) returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='30s' as $$
declare reply jsonb; rows jsonb; detail text;
begin
  if auth.uid() is null then raise insufficient_privilege using message='Authentication required'; end if;
  if p_part_id is null or p_raw is null or octet_length(p_raw)>131072
    or p_records is null or p_records not between 1 and 500 then return jsonb_build_object('code','invalid'); end if;
  begin rows:=p_raw::jsonb; exception when invalid_text_representation then return jsonb_build_object('code','invalid'); end;
  if jsonb_typeof(rows)<>'array' then return jsonb_build_object('code','invalid'); end if;
  if jsonb_array_length(rows)<>p_records or p_digest is null
    or p_digest<>encode(sha256(convert_to(encode(sha256(convert_to(p_raw,'UTF8')),'hex'),'UTF8')),'hex') then return jsonb_build_object('code','invalid'); end if;
  begin
    reply:=private.quiz_whole_begin(p_sync_id,p_operation_id,p_expected_revision,1,p_records,p_digest,p_device,false);
    if reply->>'code'<>'ok' then raise sqlstate 'PQC01' using detail=reply::text; end if;
    if reply->>'state'='committed' then return reply; end if;
    reply:=private.quiz_whole_part(p_sync_id,p_operation_id,p_part_id,0,p_raw);
    if reply->>'code'<>'ok' then raise sqlstate 'PQC01' using detail=reply::text; end if;
    reply:=private.quiz_whole_finish(p_sync_id,p_operation_id);
    if reply->>'code'<>'ok' then raise sqlstate 'PQC01' using detail=reply::text; end if;
    return reply||jsonb_build_object('state','committed');
  exception when sqlstate 'PQC01' then
    get stacked diagnostics detail=PG_EXCEPTION_DETAIL;
    return detail::jsonb;
  end;
end $$;
create function public.quiz_whole_commit(
  p_sync_id text, p_operation_id uuid, p_expected_revision bigint, p_records integer,
  p_digest text, p_device text, p_part_id uuid, p_raw text
) returns jsonb language sql security invoker set search_path='' as $$
  select private.quiz_whole_commit(p_sync_id,p_operation_id,p_expected_revision,p_records,p_digest,p_device,p_part_id,p_raw)
$$;
revoke all on function private.quiz_whole_commit(text,uuid,bigint,integer,text,text,uuid,text),
  public.quiz_whole_commit(text,uuid,bigint,integer,text,text,uuid,text) from public,anon,service_role;
grant execute on function private.quiz_whole_commit(text,uuid,bigint,integer,text,text,uuid,text),
  public.quiz_whole_commit(text,uuid,bigint,integer,text,text,uuid,text) to authenticated;
notify pgrst, 'reload schema';