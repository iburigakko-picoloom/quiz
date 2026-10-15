-- A disconnected uploader must not block every other device for an hour.
-- Preserve ownership, immutable receipts, quotas, and atomic compare-and-set.
set local lock_timeout='2s';
create or replace function private.quiz_whole_begin(p_sync_id text,p_operation_id uuid,p_expected_revision bigint,p_parts integer,p_records integer,p_digest text,p_device text,p_replace boolean default true)
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
  -- Independent devices may stage against the same head. Finish still locks the
  -- head and checks its expected revision, so only one can commit. Keep all
  -- unfinished requests and their exact bytes for the owner's retry.
  if (select count(*) from private.quiz_sync_operations where sync_id=p_sync_id and operation->>'kind'='whole-commit' and operation->>'state'='staging' and (operation->>'expectedRevision')::bigint=h.revision)>=4 then return jsonb_build_object('code','busy'); end if;
  insert into private.quiz_sync_operations values(p_sync_id,p_operation_id,manifest||jsonb_build_object('state','staging','expiresAt',clock_timestamp()+interval '1 hour'),h.revision);
  return jsonb_build_object('code','ok','state','staging','revision',h.revision);
end $$;

-- PostgREST uses the exposed RPC setting; an inner function setting does not
-- extend authenticated's default 8-second request deadline.
alter function public.quiz_whole_finish(text,uuid) set statement_timeout='30s';
notify pgrst, 'reload schema';
