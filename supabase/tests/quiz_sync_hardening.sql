-- Integration checks for 20260823172155_harden_account_owned_sync_and_add_pairing_codes.sql.
-- Run after the migration has been loaded. Every mutation is rolled back.

begin;

do $test$
declare
  sync_a text := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  sync_b text := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  sync_c text := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  legacy_id text := 'legacy_test_' || pg_catalog.encode(extensions.gen_random_bytes(8), 'hex');
  missing_legacy_id text := 'legacy_missing_' || pg_catalog.encode(extensions.gen_random_bytes(8), 'hex');
  legacy_candidate_id text := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  legacy_loser_candidate_id text := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  legacy_quota_id text := 'legacy_quota_' || pg_catalog.encode(extensions.gen_random_bytes(8), 'hex');
  legacy_quota_candidate_id text := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  payload jsonb := pg_catalog.jsonb_build_object(
    'version', 1,
    'updatedAt', clock_timestamp(),
    'localStorage', pg_catalog.jsonb_build_object('quizmake-data', '{}'),
    'indexedDbNotes', '{}'::jsonb
  );
  test_actor bytea;
  result_code text;
  remote_revision timestamptz;
  returned_revision timestamptz;
  revision_r0 timestamptz;
  revision_r1 timestamptz;
  revision_r2 timestamptz;
  returned_sync_id text;
  first_pairing_code text;
  second_pairing_code text;
  pairing_expiry timestamptz;
  before_count bigint;
  after_count bigint;
  object_count bigint;
  rate_rows_deleted bigint;
  tombstone_rows_deleted bigint;
  pairing_rows_deleted bigint;
  function_definition text;
  large_local_storage jsonb;
  large_notes jsonb;
  legacy_revision timestamptz := clock_timestamp();
  quota_sync_id text;
  safe_delete_result boolean;
  legacy_wrapper_sync_id text;
  legacy_wrapper_data jsonb;
  legacy_wrapper_revision timestamptz;
  test_user uuid := '11111111-1111-4111-8111-111111111111'::uuid;
  other_user uuid := '22222222-2222-4222-8222-222222222222'::uuid;
  other_actor bytea;
begin
  -- Sync is available only to a real signed-in account. Supabase anonymous-auth
  -- users carry the authenticated DB role too, so the JWT claim is checked in
  -- addition to function grants.
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{}',
    true
  );
  begin
    perform private.quiz_sync_actor_hash();
    raise exception 'a missing JWT was accepted for sync';
  exception when sqlstate 'PGRST' then
    null;
  end;

  perform pg_catalog.set_config('request.jwt.claim.sub', test_user::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', test_user,
      'role', 'authenticated',
      'is_anonymous', true
    )::text,
    true
  );
  begin
    perform private.quiz_sync_actor_hash();
    raise exception 'an anonymous-auth JWT was accepted for sync';
  exception when sqlstate 'PGRST' then
    null;
  end;

  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', test_user,
      'role', 'authenticated',
      'is_anonymous', false
    )::text,
    true
  );
  test_actor := private.quiz_sync_actor_hash();
  if test_actor is distinct from private.quiz_sync_hash('user:' || test_user::text) then
    raise exception 'signed-in account did not receive a stable user actor';
  end if;

  delete from private.quiz_sync_rate_limits where actor_hash = test_actor;
  delete from public.quiz_sync_data where creator_hash = test_actor;

  -- The exposed tables are RLS-protected and have no direct client grants.
  if not (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'quiz_sync_data'
  ) then
    raise exception 'quiz_sync_data must have RLS enabled';
  end if;

  if not (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'quiz_sync_pairing_codes'
  ) then
    raise exception 'quiz_sync_pairing_codes must have RLS enabled';
  end if;

  if not (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'quiz_sync_legacy_migrations'
  ) then
    raise exception 'legacy winner mapping must have RLS enabled';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.quiz_sync_data', 'select')
    or pg_catalog.has_table_privilege('anon', 'public.quiz_sync_data', 'insert')
    or pg_catalog.has_table_privilege('anon', 'public.quiz_sync_data', 'update')
    or pg_catalog.has_table_privilege('anon', 'public.quiz_sync_data', 'delete')
    or pg_catalog.has_table_privilege('authenticated', 'public.quiz_sync_data', 'select')
    or pg_catalog.has_table_privilege('anon', 'public.quiz_sync_pairing_codes', 'select')
    or pg_catalog.has_table_privilege('authenticated', 'public.quiz_sync_pairing_codes', 'select')
    or pg_catalog.has_table_privilege('anon', 'private.quiz_sync_legacy_migrations', 'select')
    or pg_catalog.has_table_privilege('authenticated', 'private.quiz_sync_legacy_migrations', 'select')
  then
    raise exception 'sync tables must not be directly accessible to API roles';
  end if;

  foreach function_definition in array array[
    'public.quiz_sync_read(text)',
    'public.quiz_sync_meta(text)',
    'public.quiz_sync_probe(text)',
    'public.quiz_sync_upsert(text,jsonb,timestamp with time zone,timestamp with time zone,boolean)',
    'public.quiz_sync_upsert_v2(text,jsonb,timestamp with time zone,timestamp with time zone,boolean)',
    'public.quiz_sync_delete_v2(text,timestamp with time zone,boolean)',
    'public.quiz_sync_delete(text)',
    'public.quiz_sync_create_pairing_code(text)',
    'public.quiz_sync_redeem_pairing_code(text)',
    'public.quiz_sync_upgrade_legacy_id(text,timestamp with time zone,text)'
  ] loop
    if pg_catalog.has_function_privilege('anon', function_definition, 'execute')
      or not pg_catalog.has_function_privilege('authenticated', function_definition, 'execute')
    then
      raise exception 'sync RPC grants are not account-only: %', function_definition;
    end if;
  end loop;

  if pg_catalog.to_regprocedure(
    'public.quiz_sync_delete(text,timestamp with time zone,boolean)'
  ) is not null then
    raise exception 'unsupported overloaded delete RPC still exists';
  end if;

  if pg_catalog.to_regprocedure(
    'public.quiz_sync_upgrade_legacy_id(text,timestamp with time zone)'
  ) is not null then
    raise exception 'only the retry-safe three-argument legacy RPC may be exposed';
  end if;

  if pg_catalog.has_function_privilege(
    'anon',
    'private.quiz_sync_hash(text)',
    'execute'
  ) then
    raise exception 'private helper functions must not be client-callable';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_cron'
  ) or pg_catalog.has_schema_privilege('anon', 'cron', 'usage')
    or pg_catalog.has_schema_privilege('authenticated', 'cron', 'usage')
  then
    raise exception 'pg_cron must be installed without exposing its schema to API roles';
  end if;

  if not exists (
    select 1
    from cron.job
    where jobname = 'quizmake-sync-housekeeping-v1'
      and schedule = '17 3 * * *'
      and active
      and command = 'select * from private.cleanup_quiz_sync_housekeeping();'
  ) then
    raise exception 'daily sync housekeeping cron job is missing or misconfigured';
  end if;

  -- Every sync function fixes an empty search_path. Compatibility wrappers are
  -- intentionally SECURITY INVOKER and delegate to hardened definer functions.
  select count(*)
    into object_count
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where (
      (namespace.nspname = 'public' and procedure.proname in (
        'quiz_sync_read',
        'quiz_sync_meta',
        'quiz_sync_probe',
        'quiz_sync_upsert',
        'quiz_sync_upsert_v2',
        'quiz_sync_delete',
        'quiz_sync_delete_v2',
        'quiz_sync_create_pairing_code',
        'quiz_sync_redeem_pairing_code',
        'quiz_sync_upgrade_legacy_id'
      ))
      or (namespace.nspname = 'private' and procedure.proname in (
        'quiz_sync_hash',
        'quiz_sync_authenticated_user',
        'quiz_sync_actor_hash',
        'quiz_sync_lock_id',
        'quiz_sync_lock_quota_actor',
        'enforce_quiz_sync_rate_limit',
        'set_quiz_sync_payload_bytes',
        'cleanup_quiz_sync_housekeeping'
      ))
    )
      and not coalesce(procedure.proconfig @> array['search_path=""']::text[], false);

  if object_count <> 0 then
    raise exception '% sync functions do not force an empty search_path', object_count;
  end if;

  if (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    where procedure.oid = 'public.quiz_sync_delete(text)'::pg_catalog.regprocedure
  ) then
    raise exception 'one-argument delete compatibility wrapper must be SECURITY INVOKER';
  end if;

  if (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    where procedure.oid = 'public.quiz_sync_upsert(text,jsonb,timestamp with time zone,timestamp with time zone,boolean)'::pg_catalog.regprocedure
  ) then
    raise exception 'legacy upsert compatibility wrapper must be SECURITY INVOKER';
  end if;

  -- Mutation endpoints must share the per-sync transaction lock; quota checks
  -- must also use the per-actor lock.
  foreach function_definition in array array[
    pg_catalog.pg_get_functiondef('public.quiz_sync_upsert_v2(text,jsonb,timestamp with time zone,timestamp with time zone,boolean)'::pg_catalog.regprocedure),
    pg_catalog.pg_get_functiondef('public.quiz_sync_delete_v2(text,timestamp with time zone,boolean)'::pg_catalog.regprocedure),
    pg_catalog.pg_get_functiondef('public.quiz_sync_create_pairing_code(text)'::pg_catalog.regprocedure),
    pg_catalog.pg_get_functiondef('public.quiz_sync_redeem_pairing_code(text)'::pg_catalog.regprocedure),
    pg_catalog.pg_get_functiondef('public.quiz_sync_upgrade_legacy_id(text,timestamp with time zone,text)'::pg_catalog.regprocedure)
  ] loop
    if pg_catalog.strpos(function_definition, 'private.quiz_sync_lock_id') = 0 then
      raise exception 'a sync mutation RPC does not use the common advisory lock';
    end if;
    if pg_catalog.strpos(function_definition, 'cleanup_quiz_sync_housekeeping') > 0 then
      raise exception 'global housekeeping must not run on an RPC hot path';
    end if;
  end loop;

  function_definition := pg_catalog.pg_get_functiondef(
    'public.quiz_sync_upsert_v2(text,jsonb,timestamp with time zone,timestamp with time zone,boolean)'::pg_catalog.regprocedure
  );
  if pg_catalog.strpos(function_definition, 'private.quiz_sync_lock_quota_actor') = 0 then
    raise exception 'upsert must serialize aggregate quota checks per actor';
  end if;
  if pg_catalog.strpos(
      function_definition,
      'effective_updated_at := greatest'
    ) <= pg_catalog.strpos(function_definition, 'private.quiz_sync_lock_quota_actor')
    or pg_catalog.strpos(
      function_definition,
      'existing_updated_at + interval ''1 microsecond'''
    ) = 0
  then
    raise exception 'upsert must allocate a strictly advancing revision after lock acquisition';
  end if;

  function_definition := pg_catalog.pg_get_functiondef(
    'public.quiz_sync_upgrade_legacy_id(text,timestamp with time zone,text)'::pg_catalog.regprocedure
  );
  if pg_catalog.strpos(
      function_definition,
      'private.quiz_sync_lock_id(p_candidate_sync_id)'
    ) = 0
    or pg_catalog.strpos(
      function_definition,
      'private.quiz_sync_lock_id(p_candidate_sync_id)'
    ) > pg_catalog.strpos(function_definition, 'private.quiz_sync_lock_quota_actor')
  then
    raise exception 'legacy candidate ID must be locked before the quota actor';
  end if;

  foreach function_definition in array array[
    'private.quiz_sync_rate_limits_actor_action_time_idx',
    'private.quiz_sync_rate_limits_requested_at_idx',
    'private.quiz_sync_tombstones_expires_at_idx',
    'private.quiz_sync_legacy_migrations_expires_idx',
    'private.quiz_sync_legacy_migrations_winner_idx',
    'public.quiz_sync_data_last_accessed_idx',
    'public.quiz_sync_data_creator_quota_idx',
    'public.quiz_sync_pairing_codes_expires_idx',
    'public.quiz_sync_pairing_codes_sync_id_uidx'
  ] loop
    if pg_catalog.to_regclass(function_definition) is null then
      raise exception 'required sync index is missing: %', function_definition;
    end if;
  end loop;

  if not (
    select index_data.indisunique and index_data.indisvalid and index_data.indisready
    from pg_catalog.pg_index as index_data
    where index_data.indexrelid = 'public.quiz_sync_pairing_codes_sync_id_uidx'::pg_catalog.regclass
  ) then
    raise exception 'pairing codes must be unique per sync ID';
  end if;

  -- Successful upload records authoritative bytes and a server revision.
  select response.result_code, response.updated_at
    into result_code, remote_revision
    from public.quiz_sync_upsert_v2(sync_a, payload, clock_timestamp(), null, false) as response;

  if result_code is distinct from 'ok' or remote_revision is null then
    raise exception 'initial upsert failed: %', result_code;
  end if;
  revision_r0 := remote_revision;

  if not exists (
    select 1 from public.quiz_sync_data
    where sync_id = sync_a and creator_hash = test_actor
  ) then
    raise exception 'new sync row was not bound to the signed-in account';
  end if;

  -- A different permanent account may know the random ID but must not learn or
  -- mutate its data. Ownership failures intentionally look like missing data.
  perform pg_catalog.set_config('request.jwt.claim.sub', other_user::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', other_user,
      'role', 'authenticated',
      'is_anonymous', false
    )::text,
    true
  );
  other_actor := private.quiz_sync_actor_hash();
  if other_actor = test_actor then
    raise exception 'different users received the same quota/ownership actor';
  end if;

  select count(*) into before_count from public.quiz_sync_read(sync_a);
  select count(*) into after_count from public.quiz_sync_meta(sync_a);
  if before_count <> 0 or after_count <> 0 then
    raise exception 'another account could read sync data or metadata';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_upsert_v2(
      sync_a, payload, clock_timestamp(), remote_revision, false
    ) as response;
  if result_code is distinct from 'not_found' then
    raise exception 'another account could address an owned sync for update';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_create_pairing_code(sync_a) as response;
  if result_code is distinct from 'not_found' then
    raise exception 'another account could create a pairing code';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_delete_v2(sync_a, remote_revision, true) as response;
  if result_code is distinct from 'not_found'
    or not exists (
      select 1 from public.quiz_sync_data
      where sync_id = sync_a and creator_hash = test_actor
    )
  then
    raise exception 'another account could delete or reassign an owned sync';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', test_user::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', test_user,
      'role', 'authenticated',
      'is_anonymous', false
    )::text,
    true
  );

  -- Rows created before account ownership existed are claimed by the first
  -- authenticated holder of their 144-bit secret, preserving installed data.
  insert into public.quiz_sync_data (sync_id, data, updated_at, last_accessed_at)
  values (sync_c, payload, clock_timestamp(), clock_timestamp());
  select count(*) into before_count from public.quiz_sync_meta(sync_c);
  if before_count <> 1 or not exists (
    select 1 from public.quiz_sync_data
    where sync_id = sync_c and creator_hash = test_actor
  ) then
    raise exception 'pre-ownership strong sync was not claimed by its authenticated holder';
  end if;
  delete from public.quiz_sync_data where sync_id = sync_c;

  if not exists (
    select 1
    from public.quiz_sync_data as row_data
    where row_data.sync_id = sync_a
      and row_data.payload_size_enforced
      and row_data.payload_bytes = pg_catalog.octet_length(row_data.data::text)
  ) then
    raise exception 'payload byte accounting trigger did not persist derived size';
  end if;

  -- Legacy oversized rows remain operable for metadata-only updates, while any
  -- new data write re-enables the size check and repairs the derived byte count.
  update public.quiz_sync_data
    set payload_bytes = 9000000,
        payload_size_enforced = false
    where sync_id = sync_a;
  update public.quiz_sync_data
    set last_accessed_at = clock_timestamp()
    where sync_id = sync_a;
  update public.quiz_sync_data
    set data = data
    where sync_id = sync_a;

  if not exists (
    select 1 from public.quiz_sync_data
    where sync_id = sync_a
      and payload_size_enforced
      and payload_bytes < 8388608
  ) then
    raise exception 'a data write did not repair legacy payload accounting';
  end if;

  begin
    update public.quiz_sync_data
      set payload_bytes = 8388609,
          payload_size_enforced = true
      where sync_id = sync_a;
    raise exception 'enforced payload size constraint accepted more than 8 MiB';
  exception when check_violation then
    null;
  end;

  -- Expected validation failures return rows, allowing the rate event to stay
  -- committed in the surrounding request transaction.
  select count(*) into before_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'upsert';

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upsert_v2(
      sync_b,
      '{"version":1,"localStorage":[]}'::jsonb,
      clock_timestamp(),
      null,
      false
    ) as response;

  select count(*) into after_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'upsert';

  if result_code is distinct from 'invalid_sync_payload'
    or after_count <> before_count + 1
  then
    raise exception 'expected upsert failure did not retain its rate event';
  end if;

  select pg_catalog.jsonb_object_agg('local-' || item, 'x')
    into large_local_storage
    from pg_catalog.generate_series(1, 6000) as item;
  select pg_catalog.jsonb_object_agg('note-' || item, 'x')
    into large_notes
    from pg_catalog.generate_series(1, 4001) as item;

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upsert_v2(
      sync_b,
      pg_catalog.jsonb_build_object(
        'version', 1,
        'updatedAt', clock_timestamp(),
        'localStorage', large_local_storage,
        'indexedDbNotes', large_notes - 'note-4001'
      ),
      clock_timestamp(),
      null,
      false
    ) as response;

  if result_code is distinct from 'ok' or returned_revision is null then
    raise exception 'combined key limit rejected the valid 10,000-key boundary';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_upsert_v2(
      sync_b,
      pg_catalog.jsonb_build_object(
        'version', 1,
        'updatedAt', clock_timestamp(),
        'localStorage', large_local_storage,
        'indexedDbNotes', large_notes
      ),
      clock_timestamp(),
      null,
      false
    ) as response;

  if result_code is distinct from 'invalid_sync_payload' then
    raise exception 'combined localStorage + note key limit was not enforced';
  end if;

  delete from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'upsert';

  select response.result_code, response.updated_at
    into result_code, revision_r1
    from public.quiz_sync_upsert_v2(
      sync_a,
      payload,
      clock_timestamp(),
      revision_r0,
      false
    ) as response;
  if result_code is distinct from 'ok'
    or revision_r1 is null
    or revision_r1 <= revision_r0
  then
    raise exception 'exact R0 CAS did not produce a strictly newer R1';
  end if;

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upsert_v2(
      sync_a,
      payload,
      clock_timestamp(),
      revision_r0,
      false
    ) as response;

  if result_code is distinct from 'conflict'
    or returned_revision is distinct from revision_r1
  then
    raise exception 'stale R0 CAS was not rejected with authoritative R1';
  end if;

  select response.result_code, response.updated_at
    into result_code, revision_r2
    from public.quiz_sync_upsert_v2(
      sync_a,
      payload,
      clock_timestamp(),
      revision_r1,
      false
    ) as response;
  if result_code is distinct from 'ok'
    or revision_r2 is null
    or revision_r2 <= revision_r1
  then
    raise exception 'intervening exact R1 CAS did not produce R2';
  end if;

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upsert_v2(
      sync_a,
      payload,
      clock_timestamp(),
      revision_r1,
      true
    ) as response;
  if result_code is distinct from 'conflict'
    or returned_revision is distinct from revision_r2
    or not exists (
      select 1 from public.quiz_sync_data
      where sync_id = sync_a and updated_at = revision_r2
    )
  then
    raise exception 'force bypassed CAS after an intervening R2 write';
  end if;

  select response.result_code, response.updated_at
    into result_code, remote_revision
    from public.quiz_sync_upsert_v2(
      sync_a,
      payload,
      clock_timestamp(),
      revision_r2,
      true
    ) as response;
  if result_code is distinct from 'ok'
    or remote_revision is null
    or remote_revision <= revision_r2
  then
    raise exception 'force with the exact confirmed R2 revision did not succeed';
  end if;

  -- A deployed pre-v2 client ignores result_code and may reuse a returned
  -- revision.  Its compatibility endpoint must therefore mask every expected
  -- failure as an invalid legacy record while still committing the rate event.
  select count(*) into before_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'upsert';

  select response.sync_id, response.data, response.updated_at
    into legacy_wrapper_sync_id, legacy_wrapper_data, legacy_wrapper_revision
    from public.quiz_sync_upsert(
      sync_a,
      payload,
      clock_timestamp(),
      revision_r2,
      false
    ) as response;

  select count(*) into after_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'upsert';

  if legacy_wrapper_sync_id is not null
    or legacy_wrapper_data is distinct from '{}'::jsonb
    or legacy_wrapper_revision is not null
    or after_count <> before_count + 1
  then
    raise exception 'legacy upsert failure exposed valid payload/revision or lost its rate event';
  end if;

  -- Delete is CAS-protected, writes a tombstone, and cannot be performed by
  -- the historical one-argument wrapper.
  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_delete_v2(
      sync_a,
      revision_r2,
      false
    ) as response;

  if result_code is distinct from 'conflict'
    or returned_revision is distinct from remote_revision
    or not exists (select 1 from public.quiz_sync_data where sync_id = sync_a)
  then
    raise exception 'stale delete CAS did not preserve the row';
  end if;

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_delete_v2(sync_a, revision_r2, true) as response;
  if result_code is distinct from 'conflict'
    or returned_revision is distinct from remote_revision
    or not exists (
      select 1 from public.quiz_sync_data
      where sync_id = sync_a and updated_at = remote_revision
    )
  then
    raise exception 'force delete bypassed CAS after an intervening write';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_delete_v2(sync_a, remote_revision, true) as response;

  if result_code is distinct from 'ok'
    or exists (select 1 from public.quiz_sync_data where sync_id = sync_a)
    or not exists (
      select 1 from private.quiz_sync_tombstones
      where sync_id_hash = private.quiz_sync_hash('sync:' || sync_a)
        and expires_at > clock_timestamp()
    )
  then
    raise exception 'CAS delete did not atomically delete and tombstone the sync';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_upsert_v2(sync_a, payload, clock_timestamp(), null, false) as response;

  if result_code is distinct from 'deleted' then
    raise exception 'tombstone did not block stale recreation';
  end if;

  select response.result_code, response.updated_at
    into result_code, remote_revision
    from public.quiz_sync_upsert_v2(sync_a, payload, clock_timestamp(), null, true) as response;

  if result_code is distinct from 'deleted'
    or exists (select 1 from public.quiz_sync_data where sync_id = sync_a)
    or not exists (
      select 1 from private.quiz_sync_tombstones
      where sync_id_hash = private.quiz_sync_hash('sync:' || sync_a)
        and expires_at > clock_timestamp()
    )
  then
    raise exception 'force resurrected a sync protected by an active tombstone';
  end if;

  update private.quiz_sync_tombstones
    set expires_at = clock_timestamp() - interval '1 second'
    where sync_id_hash = private.quiz_sync_hash('sync:' || sync_a);

  select response.result_code, response.updated_at
    into result_code, remote_revision
    from public.quiz_sync_upsert_v2(sync_a, payload, clock_timestamp(), null, false) as response;

  if result_code is distinct from 'ok'
    or remote_revision is null
    or exists (
      select 1 from private.quiz_sync_tombstones
      where sync_id_hash = private.quiz_sync_hash('sync:' || sync_a)
    )
  then
    raise exception 'expired tombstone did not permit clean recreation';
  end if;

  select public.quiz_sync_delete(sync_a) into safe_delete_result;
  if safe_delete_result
    or not exists (select 1 from public.quiz_sync_data where sync_id = sync_a)
  then
    raise exception 'one-argument compatibility delete performed destructive work';
  end if;

  insert into private.quiz_sync_rate_limits (actor_hash, action, requested_at)
  values (test_actor, 'housekeeping_test', clock_timestamp() - interval '2 days');
  insert into private.quiz_sync_tombstones (sync_id_hash, deleted_at, expires_at)
  values (
    private.quiz_sync_hash('sync:' || sync_c),
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '1 day'
  );
  insert into public.quiz_sync_pairing_codes (
    code_hash, sync_id, created_at, expires_at
  ) values (
    private.quiz_sync_hash('pair:EXPIRED1'),
    sync_a,
    clock_timestamp() - interval '10 minutes',
    clock_timestamp() - interval '5 minutes'
  );
  insert into private.quiz_sync_legacy_migrations (
    legacy_id_hash,
    winner_sync_id,
    winner_updated_at,
    created_at,
    expires_at
  ) values (
    private.quiz_sync_hash('legacy:expired-housekeeping'),
    sync_a,
    remote_revision,
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '1 day'
  );

  select cleanup.rate_limits_deleted,
         cleanup.tombstones_deleted,
         cleanup.pairing_codes_deleted
    into rate_rows_deleted, tombstone_rows_deleted, pairing_rows_deleted
    from private.cleanup_quiz_sync_housekeeping(clock_timestamp()) as cleanup;

  if rate_rows_deleted < 1
    or tombstone_rows_deleted < 1
    or pairing_rows_deleted < 1
    or exists (
      select 1 from private.quiz_sync_rate_limits
      where actor_hash = test_actor and action = 'housekeeping_test'
    )
    or exists (
      select 1 from private.quiz_sync_tombstones
      where sync_id_hash = private.quiz_sync_hash('sync:' || sync_c)
    )
    or exists (
      select 1 from public.quiz_sync_pairing_codes
      where code_hash = private.quiz_sync_hash('pair:EXPIRED1')
    )
    or exists (
      select 1 from private.quiz_sync_legacy_migrations
      where legacy_id_hash = private.quiz_sync_hash('legacy:expired-housekeeping')
    )
  then
    raise exception 'scheduled housekeeping function did not remove expired rows';
  end if;

  -- Only one short-lived hashed pairing code exists per sync. Redemption is
  -- atomic and one-use.
  select response.result_code, response.pairing_code, response.expires_at
    into result_code, first_pairing_code, pairing_expiry
    from public.quiz_sync_create_pairing_code(sync_a) as response;

  if result_code is distinct from 'ok'
    or first_pairing_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$'
    or pairing_expiry <= clock_timestamp()
    or pairing_expiry > clock_timestamp() + interval '6 minutes'
  then
    raise exception 'pairing code creation returned an invalid token';
  end if;

  select response.result_code, response.pairing_code
    into result_code, second_pairing_code
    from public.quiz_sync_create_pairing_code(sync_a) as response;

  if result_code is distinct from 'ok'
    or (select count(*) from public.quiz_sync_pairing_codes where sync_id = sync_a) <> 1
  then
    raise exception 'pairing code replacement did not preserve one-code-per-sync invariant';
  end if;

  if first_pairing_code is distinct from second_pairing_code then
    select response.result_code
      into result_code
      from public.quiz_sync_redeem_pairing_code(first_pairing_code) as response;
    if result_code is distinct from 'not_found_or_expired' then
      raise exception 'superseded pairing code remained redeemable';
    end if;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', other_user::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', other_user,
      'role', 'authenticated',
      'is_anonymous', false
    )::text,
    true
  );
  select response.result_code
    into result_code
    from public.quiz_sync_redeem_pairing_code(second_pairing_code) as response;
  if result_code is distinct from 'not_found_or_expired'
    or not exists (
      select 1 from public.quiz_sync_pairing_codes
      where sync_id = sync_a
    )
  then
    raise exception 'another account could inspect or consume a pairing code';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', test_user::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', test_user,
      'role', 'authenticated',
      'is_anonymous', false
    )::text,
    true
  );

  select response.result_code, response.sync_id
    into result_code, returned_sync_id
    from public.quiz_sync_redeem_pairing_code(second_pairing_code) as response;

  if result_code is distinct from 'ok' or returned_sync_id is distinct from sync_a then
    raise exception 'pairing code did not redeem to the strong sync ID';
  end if;

  select response.result_code
    into result_code
    from public.quiz_sync_redeem_pairing_code(second_pairing_code) as response;
  if result_code is distinct from 'not_found_or_expired' then
    raise exception 'pairing code could be redeemed more than once';
  end if;

  select count(*) into before_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'pair_redeem';
  select response.result_code
    into result_code
    from public.quiz_sync_redeem_pairing_code('NOTVALID') as response;
  select count(*) into after_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'pair_redeem';
  if result_code is distinct from 'invalid_pairing_code'
    or after_count <> before_count + 1
  then
    raise exception 'expected pairing failure did not retain its rate event';
  end if;

  -- Legacy IDs rotate atomically only with the exact authoritative revision and
  -- a client-persisted candidate, making a retry after response loss idempotent.
  insert into public.quiz_sync_data (sync_id, data, updated_at, last_accessed_at)
  values (legacy_id, payload, legacy_revision, legacy_revision);

  select count(*) into before_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'legacy_upgrade';
  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upgrade_legacy_id(
      'bad!',
      legacy_revision,
      legacy_candidate_id
    ) as response;
  select count(*) into after_count
  from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'legacy_upgrade';
  if result_code is distinct from 'invalid_legacy_sync_id'
    or returned_revision is not null
    or after_count <> before_count + 1
  then
    raise exception 'invalid legacy failure leaked a revision or lost its rate event';
  end if;

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upgrade_legacy_id(
      legacy_id,
      legacy_revision - interval '1 second',
      legacy_candidate_id
    ) as response;
  if result_code is distinct from 'conflict'
    or returned_revision is not null
  then
    raise exception 'legacy migration CAS failed or disclosed its authoritative revision';
  end if;

  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upgrade_legacy_id(
      missing_legacy_id,
      legacy_revision,
      legacy_loser_candidate_id
    ) as response;
  if result_code is distinct from 'not_found'
    or returned_revision is not null
  then
    raise exception 'missing legacy ID disclosed a revision';
  end if;

  select response.result_code, response.sync_id, response.updated_at
    into result_code, returned_sync_id, returned_revision
    from public.quiz_sync_upgrade_legacy_id(
      legacy_id,
      legacy_revision,
      legacy_candidate_id
    ) as response;
  if result_code is distinct from 'ok'
    or returned_sync_id is distinct from legacy_candidate_id
    or returned_revision is distinct from legacy_revision
    or exists (select 1 from public.quiz_sync_data where sync_id = legacy_id)
    or not exists (select 1 from public.quiz_sync_data where sync_id = returned_sync_id)
  then
    raise exception 'legacy migration was not an atomic strong-ID rotation';
  end if;

  if not exists (
    select 1
    from private.quiz_sync_legacy_migrations as migration
    where migration.legacy_id_hash = private.quiz_sync_hash('legacy:' || legacy_id)
      and migration.winner_sync_id = legacy_candidate_id
      and migration.winner_updated_at = legacy_revision
      and migration.creator_hash = test_actor
      and migration.expires_at > clock_timestamp() + interval '89 days'
      and migration.expires_at < clock_timestamp() + interval '91 days'
  ) then
    raise exception 'legacy rotation did not persist its bounded HMAC winner mapping';
  end if;

  -- Model two tabs racing with different durable candidates. After the first
  -- response is lost, the losing candidate must still converge to the winner.
  select response.result_code, response.sync_id, response.updated_at
    into result_code, returned_sync_id, returned_revision
    from public.quiz_sync_upgrade_legacy_id(
      legacy_id,
      legacy_revision,
      legacy_loser_candidate_id
    ) as response;
  if result_code is distinct from 'ok'
    or returned_sync_id is distinct from legacy_candidate_id
    or returned_revision is distinct from legacy_revision
    or exists (
      select 1 from public.quiz_sync_data
      where sync_id = legacy_loser_candidate_id
    )
  then
    raise exception 'different-candidate legacy retry did not converge to the committed winner';
  end if;

  delete from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'legacy_upgrade';
  select response.result_code, response.updated_at
    into result_code, returned_revision
    from public.quiz_sync_upgrade_legacy_id(
      legacy_id,
      legacy_revision - interval '1 second',
      legacy_loser_candidate_id
    ) as response;
  if result_code is distinct from 'conflict'
    or returned_revision is not null
  then
    raise exception 'mapped legacy conflict disclosed the winner revision';
  end if;

  -- Assigning a pre-creator_hash legacy row to an actor must not bypass that
  -- actor's 50-row/128-MiB aggregate quota.
  delete from private.quiz_sync_rate_limits
  where actor_hash = test_actor and action = 'legacy_upgrade';
  delete from public.quiz_sync_data where creator_hash = test_actor;
  insert into public.quiz_sync_data (
    sync_id, data, updated_at, last_accessed_at, creator_hash
  )
  select
    pg_catalog.encode(extensions.gen_random_bytes(18), 'hex'),
    payload,
    clock_timestamp(),
    clock_timestamp(),
    test_actor
  from pg_catalog.generate_series(1, 50);
  insert into public.quiz_sync_data (sync_id, data, updated_at, last_accessed_at)
  values (legacy_quota_id, payload, legacy_revision, legacy_revision);

  select response.result_code
    into result_code
    from public.quiz_sync_upgrade_legacy_id(
      legacy_quota_id,
      legacy_revision,
      legacy_quota_candidate_id
    ) as response;
  if result_code is distinct from 'quota_exceeded'
    or not exists (select 1 from public.quiz_sync_data where sync_id = legacy_quota_id)
    or exists (select 1 from public.quiz_sync_data where sync_id = legacy_quota_candidate_id)
  then
    raise exception 'legacy ownership transfer bypassed actor quota or partially rotated';
  end if;

  -- Payload over 32 MiB is rejected as an expected result row, not an error.
  select response.result_code
    into result_code
    from public.quiz_sync_upsert_v2(
      sync_b,
      pg_catalog.jsonb_build_object(
        'version', 1,
        'localStorage', pg_catalog.jsonb_build_object('oversized', pg_catalog.repeat('x', 33554432))
      ),
      clock_timestamp(),
      null,
      false
    ) as response;
  if result_code is distinct from 'sync_payload_too_large' then
    raise exception 'server payload limit was not enforced';
  end if;

  -- Row quota is evaluated under the actor lock and uses the stored byte size.
  delete from public.quiz_sync_data where creator_hash = test_actor;
  insert into public.quiz_sync_data (
    sync_id, data, updated_at, last_accessed_at, creator_hash
  )
  select
    pg_catalog.encode(extensions.gen_random_bytes(18), 'hex'),
    payload,
    clock_timestamp(),
    clock_timestamp(),
    test_actor
  from pg_catalog.generate_series(1, 50);

  quota_sync_id := pg_catalog.encode(extensions.gen_random_bytes(18), 'hex');
  select response.result_code
    into result_code
    from public.quiz_sync_upsert_v2(
      quota_sync_id,
      payload,
      clock_timestamp(),
      null,
      false
    ) as response;
  if result_code is distinct from 'quota_exceeded' then
    raise exception '50-row per-actor quota was not enforced';
  end if;

  raise notice 'quiz sync hardening integration checks passed';
end;
$test$;

rollback;
