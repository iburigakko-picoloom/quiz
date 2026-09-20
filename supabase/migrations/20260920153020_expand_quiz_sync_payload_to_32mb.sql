-- Increase only the per-snapshot limit. Keep authentication, ownership, CAS,
-- rate limits, the 128 MiB per-account quota and existing rows unchanged.
set local lock_timeout = '5s';

do $migration$
declare
  definition text;
  old_guard constant text := 'incoming_payload_bytes > 8388608';
  new_guard constant text := 'incoming_payload_bytes > 33554432';
begin
  select pg_catalog.pg_get_functiondef(
    'public.quiz_sync_upsert_v2(text,jsonb,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure
  ) into definition;
  -- Preserve the deployed function's security fixes instead of replacing it
  -- with a potentially older copy. Fail closed if the expected guard changed.
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_guard, '')))
      / pg_catalog.length(old_guard) = 1 then
    execute pg_catalog.replace(definition, old_guard, new_guard);
  elsif pg_catalog.strpos(definition, old_guard) = 0 and pg_catalog.strpos(definition, new_guard) > 0 then
    null; -- Already expanded.
  else
    raise exception 'Unexpected quiz_sync_upsert_v2 payload guard; migration aborted';
  end if;
end
$migration$;

alter table public.quiz_sync_data
  drop constraint quiz_sync_data_payload_size_limit,
  add constraint quiz_sync_data_payload_size_limit
    check (not payload_size_enforced or payload_bytes <= 33554432) not valid;

notify pgrst, 'reload schema';
