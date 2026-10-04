-- UNAPPLIED: requires approval before production deployment.
-- One canonical stream per existing, non-anonymous Auth account. Existing
-- streams, records, receipts and tombstones are never merged or reassigned.
create table private.quiz_sync_account_defaults (
  actor_hash bytea primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  sync_id text not null unique check (sync_id ~ '^[0-9a-f]{36}$'),
  created_at timestamptz not null default now()
);
-- No FK to quiz_sync_data: deleting a canonical stream must not silently create
-- a replacement or resurrect queued data. Account deletion removes the mapping.
alter table private.quiz_sync_account_defaults enable row level security;
revoke all on private.quiz_sync_account_defaults from public, anon, authenticated;

create function private.quiz_sync_resolve_account(p_existing_sync_id text default null)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '10s' as $$
declare
  account_id uuid := private.quiz_sync_authenticated_user();
  actor bytea := private.quiz_sync_actor_hash();
  canonical text;
  selected text;
  stamp timestamptz;
  seed jsonb;
  choices jsonb;
begin
  perform private.enforce_quiz_sync_rate_limit('account_resolve', 30, interval '1 minute');
  -- Serializes first resolution across devices independently of stream/quota
  -- locks. Authentication also holds the existing account-deletion shared lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('quiz-sync-default:' || account_id::text, 0));
  if p_existing_sync_id is not null then
    if p_existing_sync_id !~ '^[0-9a-f]{36}$' then return jsonb_build_object('code','legacy_connection'); end if;
    -- Knowing an ID never establishes ownership. In particular, unowned legacy
    -- rows are not claimed through this endpoint.
    if not exists(select 1 from public.quiz_sync_data d where d.sync_id=p_existing_sync_id and d.creator_hash=actor) then
      return jsonb_build_object('code','not_found');
    end if;
  end if;
  select d.sync_id into canonical from private.quiz_sync_account_defaults d where d.actor_hash=actor and d.user_id=account_id;
  if canonical is not null then
    perform private.quiz_sync_lock_id(canonical);
    if not exists(select 1 from public.quiz_sync_data d where d.sync_id=canonical and d.creator_hash=actor) then
      return jsonb_build_object('code','deleted');
    end if;
    if p_existing_sync_id is not null and p_existing_sync_id<>canonical then
      return jsonb_build_object('code','migration_required','syncId',canonical);
    end if;
    return jsonb_build_object('code','ok','syncId',canonical,'created',false);
  end if;
  if p_existing_sync_id is not null then selected:=p_existing_sync_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object('syncId',d.sync_id,'updatedAt',d.updated_at) order by d.updated_at desc,d.sync_id),'[]') into choices
      from (select sync_id,updated_at from public.quiz_sync_data where creator_hash=actor order by updated_at desc,sync_id limit 51) d;
    if jsonb_array_length(choices)>1 then return jsonb_build_object('code','selection_required','choices',choices); end if;
    if jsonb_array_length(choices)=1 then selected:=choices->0->>'syncId'; end if;
    if selected is not null and selected !~ '^[0-9a-f]{36}$' then return jsonb_build_object('code','legacy_connection'); end if;
  end if;
  if selected is not null then
    perform private.quiz_sync_lock_id(selected);
    if not exists(select 1 from public.quiz_sync_data d where d.sync_id=selected and d.creator_hash=actor) then return jsonb_build_object('code','not_found'); end if;
  else
    -- Core PostgreSQL UUID randomness; no new extension, predictable user-derived
    -- IDs, browser credentials or additional persistent access tokens.
    loop
      selected:=replace(pg_catalog.gen_random_uuid()::text,'-','') || substr(replace(pg_catalog.gen_random_uuid()::text,'-',''),1,4);
      perform private.quiz_sync_lock_id(selected);
      exit when not exists(select 1 from public.quiz_sync_data d where d.sync_id=selected);
    end loop;
    perform private.quiz_sync_lock_quota_actor(actor);
    -- A legacy client may have created a stream since the initial read. Do not
    -- create a second stream or take an existing ID lock after the quota lock.
    if exists(select 1 from public.quiz_sync_data d where d.creator_hash=actor) then
      return jsonb_build_object('code','retry');
    end if;
    stamp:=clock_timestamp();
    seed:=jsonb_build_object('version',1,'updatedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'localStorage',jsonb_build_object('quiz-make-app-data-v1','{"version":1,"folders":[],"problemSets":[],"questions":[],"progress":[],"answerLogs":[]}'),
      'indexedDbNotes','{}'::jsonb);
    insert into public.quiz_sync_data(sync_id,data,updated_at,last_accessed_at,creator_hash,payload_bytes)
      values(selected,seed,stamp,stamp,actor,octet_length(seed::text));
  end if;
  insert into private.quiz_sync_account_defaults(actor_hash,user_id,sync_id) values(actor,account_id,selected);
  return jsonb_build_object('code','ok','syncId',selected,'created',seed is not null);
end $$;

create function public.quiz_sync_resolve_account(p_existing_sync_id text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.quiz_sync_resolve_account(p_existing_sync_id)
$$;
revoke all on function private.quiz_sync_resolve_account(text) from public, anon, authenticated;
revoke all on function public.quiz_sync_resolve_account(text) from public, anon, authenticated;
grant execute on function private.quiz_sync_resolve_account(text) to authenticated;
grant execute on function public.quiz_sync_resolve_account(text) to authenticated;
comment on function public.quiz_sync_resolve_account(text) is
  'Resolves only the caller account canonical sync stream; rejects anonymous/deleted users and foreign/unowned IDs; never merges streams.';
