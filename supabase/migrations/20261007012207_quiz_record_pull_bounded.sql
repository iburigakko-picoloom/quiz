-- Keep one existing revision intact. Old callers request up to twenty revisions;
-- that can aggregate tens of MiB and exceed the authenticated REST timeout.
-- Do not split revisions, change cursors, loosen ownership or reopen old writers.
create or replace function private.quiz_sync_v2_pull(p_sync_id text,p_cursor bigint,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.quiz_sync_v2_access(p_sync_id);
  if exists(select 1 from private.quiz_sync_heads where sync_id=p_sync_id and whole_enabled) then
    return jsonb_build_object('code','whole_required');
  end if;
  return private.quiz_sync_v2_pull_record(p_sync_id,p_cursor,
    case when p_limit between 1 and 20 then 1 else p_limit end);
end $$;
