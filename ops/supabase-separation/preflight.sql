-- READ ONLY. Run against the source, and against the destination AFTER schema
-- bootstrap. One statement gives a consistent snapshot. Outputs aggregate counts
-- and schema metadata only: no UUIDs, sync IDs, email, payloads, hashes or secrets.
with evidence as (
  select owner_id as user_id, 'group_owner' as reason from public.quiz_groups
  union all select user_id, 'group_member' from public.quiz_group_members
  union all select shared_by, 'group_sharer' from public.quiz_group_problem_sets
  union all select created_by, 'invite_creator' from public.quiz_group_invites
  union all select owner_id, 'published_owner' from public.shared_problem_sets
  union all select reporter_id, 'reporter' from public.problem_reports
  union all select actor_id, 'copy_actor' from public.problem_set_copies where actor_id is not null
  union all select u.id, 'sync_owner'
    from auth.users u join public.quiz_sync_data s
      on s.creator_hash = private.quiz_sync_hash('user:' || u.id::text)
  union all select user_id, 'quiz_line_identity' from auth.identities
    where provider = 'custom:quizmake-line'
), quiz_tables(schema_name, table_name) as (
  values
    ('public', 'quiz_profiles'), ('public', 'quiz_groups'),
    ('public', 'quiz_group_members'), ('public', 'quiz_group_invites'),
    ('public', 'quiz_group_problem_sets'), ('public', 'shared_problem_sets'),
    ('public', 'shared_questions'), ('public', 'problem_set_copies'),
    ('public', 'problem_reports'), ('public', 'quiz_sync_data'),
    ('public', 'quiz_sync_pairing_codes'),
    ('private', 'quiz_sync_security_config'), ('private', 'quiz_sync_rate_limits'),
    ('private', 'quiz_sync_tombstones'), ('private', 'quiz_sync_legacy_migrations')
), required_rpcs(signature) as (
  values
    ('public.delete_quiz_account()'), ('public.set_profile_display_name(text)'),
    ('public.publish_problem_set(jsonb,jsonb)'), ('public.move_published_set_folder(uuid,jsonb)'),
    ('public.unpublish_problem_set(uuid)'), ('public.get_shared_problem_set(uuid,text)'),
    ('public.record_problem_set_copy(uuid,uuid,text)'), ('public.list_my_groups()'),
    ('public.create_quiz_group(text)'), ('public.create_group_invite(uuid)'),
    ('public.join_quiz_group(text)'), ('public.list_group_problem_sets(uuid)'),
    ('public.list_quiz_group_members(uuid)'), ('public.remove_quiz_group_member(uuid,uuid)'),
    ('public.quiz_sync_read(text)'), ('public.quiz_sync_meta(text)'),
    ('public.quiz_sync_probe(text)'), ('public.quiz_sync_create_pairing_code(text)'),
    ('public.quiz_sync_redeem_pairing_code(text)'),
    ('public.quiz_sync_upsert_v2(text,jsonb,timestamptz,timestamptz,boolean)'),
    ('public.quiz_sync_delete_v2(text,timestamptz,boolean)'),
    ('public.quiz_sync_upgrade_legacy_id(text,timestamptz,text)')
)
select jsonb_build_object(
  'checked_at', now(),
  'counts', jsonb_build_object(
    'quiz_profiles', (select count(*) from public.quiz_profiles),
    'groups', (select count(*) from public.quiz_groups),
    'members', (select count(*) from public.quiz_group_members),
    'invites', (select count(*) from public.quiz_group_invites),
    'group_links', (select count(*) from public.quiz_group_problem_sets),
    'published_sets', (select count(*) from public.shared_problem_sets),
    'questions', (select count(*) from public.shared_questions),
    'copies', (select count(*) from public.problem_set_copies),
    'reports', (select count(*) from public.problem_reports),
    'auth_users', (select count(*) from auth.users),
    'evidenced_quiz_users', (select count(distinct user_id) from evidence),
    'profiles_without_activity_evidence', (select count(*) from public.quiz_profiles p
      where not exists (select 1 from evidence e where e.user_id = p.user_id)),
    'storage_buckets', (select count(*) from storage.buckets),
    'storage_objects', (select count(*) from storage.objects)
  ),
  'sync', (select jsonb_build_object(
    'records', count(*),
    'owner_matched', count(*) filter (where exists (
      select 1 from auth.users u where s.creator_hash = private.quiz_sync_hash('user:' || u.id::text))),
    'owner_null', count(*) filter (where s.creator_hash is null),
    'owner_unmapped', count(*) filter (where s.creator_hash is not null and not exists (
      select 1 from auth.users u where s.creator_hash = private.quiz_sync_hash('user:' || u.id::text))),
    'payload_bytes', coalesce(sum(s.payload_bytes), 0)
  ) from public.quiz_sync_data s),
  'transient_rows', jsonb_build_object(
    'pairing_codes', (select count(*) from public.quiz_sync_pairing_codes),
    'tombstones', (select count(*) from private.quiz_sync_tombstones),
    'legacy_mappings', (select count(*) from private.quiz_sync_legacy_migrations)
  ),
  'quiz_tables_without_rls', (select coalesce(jsonb_agg(q.schema_name || '.' || q.table_name), '[]')
    from quiz_tables q
    left join pg_namespace n on n.nspname = q.schema_name
    left join pg_class c on c.relnamespace = n.oid and c.relname = q.table_name and c.relkind = 'r'
    where c.oid is null or not c.relrowsecurity),
  'non_quiz_tables', (select coalesce(jsonb_agg(n.nspname || '.' || c.relname order by c.relname), '[]')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
      and not exists (select 1 from quiz_tables q where q.schema_name = n.nspname and q.table_name = c.relname)),
  'auth_insert_triggers', (select coalesce(jsonb_agg(t.tgname order by t.tgname), '[]')
    from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal),
  'missing_rpc_signatures', (select coalesce(jsonb_agg(signature), '[]') from required_rpcs
    where to_regprocedure(signature) is null),
  'sync_write_contracts', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.proname, 'arguments', pg_get_function_identity_arguments(p.oid),
      'returns', pg_get_function_result(p.oid)) order by p.proname), '[]')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('quiz_sync_upsert_v2', 'quiz_sync_delete_v2'))
) as separation_preflight;
