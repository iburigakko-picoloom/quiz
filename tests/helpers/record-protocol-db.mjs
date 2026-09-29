import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export async function createRecordProtocolDatabase() {
  const pg = await PGlite.create();
  // Platform auth/rate-limit helpers are isolated fixtures. Record protocol and
  // Snapshot bridge SQL run unchanged against PostgreSQL, including transactions.
  await pg.exec(`
    create role anon; create role authenticated; create schema private;
    create table public.quiz_sync_data(sync_id text primary key, data jsonb not null default '{}', updated_at timestamptz not null, last_accessed_at timestamptz not null default now(), creator_hash bytea, payload_bytes bigint not null default 0);
    create function private.quiz_sync_actor_hash() returns bytea language plpgsql as $$
    begin
      if coalesce(current_setting('test.actor',true),'')='' then raise exception 'authentication_required'; end if;
      return sha256(convert_to(current_setting('test.actor'),'UTF8'));
    end $$;
    create function private.quiz_sync_lock_id(text) returns void language sql as $$ select pg_advisory_xact_lock(hashtextextended($1,0)) $$;
    create function private.quiz_sync_lock_quota_actor(bytea) returns void language sql as $$ select pg_advisory_xact_lock(hashtextextended(encode($1,'hex'),0)) $$;
    create function private.enforce_quiz_sync_rate_limit(text,integer,interval) returns void language sql as $$ select $$;
    select set_config('test.actor','owner',false);
  `);
  await pg.exec(await readFile(new URL('../../supabase/migrations/20260929223301_quiz_sync_record_protocol.sql', import.meta.url), 'utf8'));
  return pg;
}
