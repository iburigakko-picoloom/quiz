-- The legacy diagnostic/export RPC materializes one complete JSON response.
-- A verified ~26 MB snapshot takes 9 seconds including the set-returning RPC
-- and API serialization, leaving no load margin under the old 10-second cap.
-- PostgREST reads this exposed function's timeout from its schema cache.
-- Keep all other RPC/role limits, ownership checks and execute grants intact.
set local lock_timeout='2s';
alter function public.quiz_sync_read(text) set statement_timeout='30s';
notify pgrst, 'reload schema';
