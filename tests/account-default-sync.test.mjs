import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRecordProtocolDatabase} from './helpers/record-protocol-db.mjs';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const first='a'.repeat(36),second='b'.repeat(36),foreign='c'.repeat(36),unowned='d'.repeat(36);
test('account default RPC permission and migration matrix (unchanged migration on local PostgreSQL)',async t=>{
  const pg=await createRecordProtocolDatabase();
  try{
    await pg.exec(`create role service_role;
      alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
      create function private.quiz_sync_hash(text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;
      grant usage on schema private to authenticated;
      create table private.qa_rate_checks(action text);
      create or replace function private.enforce_quiz_sync_rate_limit(text,integer,interval) returns void language plpgsql as $$begin
        insert into private.qa_rate_checks values($1);
        if current_setting('test.rate_limited',true)='true' then raise exception 'rate_limited';end if;
      end$$;`);
    const guard=await readFile(new URL('../supabase/migrations/20260823180238_delete_account_owned_sync_data.sql',import.meta.url),'utf8');
    await pg.exec(guard.slice(0,guard.indexOf('create or replace function public.')));
    const migration=await readFile(new URL('../supabase/migrations/20261004151805_quiz_account_default_sync.sql',import.meta.url),'utf8');await pg.exec(migration);
    const auth=async(user=a,anonymous=false)=>{await pg.exec('reset role');await pg.query("select set_config('request.jwt.claims',$1,false),set_config('test.rate_limited','false',false)",[JSON.stringify({sub:user,is_anonymous:anonymous,user_metadata:{sub:b,is_anonymous:false}})]);};
    const reset=async()=>{await auth();await pg.exec(`delete from public.quiz_sync_data;delete from auth.users;insert into auth.users values('${a}'),('${b}');delete from private.qa_rate_checks;`);};
    const call=async(candidate=null)=>{await pg.exec('set role authenticated');try{return (await pg.query('select public.quiz_sync_resolve_account($1) as value',[candidate])).rows[0].value;}finally{await pg.exec('reset role')}};
    const seed=async(id,user=a,owner=true)=>{await auth(user);await pg.query("insert into public.quiz_sync_data(sync_id,data,updated_at,creator_hash) values($1,'{}',now(),case when $2 then private.quiz_sync_actor_hash() else null end)",[id,owner]);};
    await t.test('anon/service_role execution and direct private-table access are denied despite default grants; public wrapper is invoker',async()=>{
      await reset();await pg.exec('set role anon');await assert.rejects(pg.query('select public.quiz_sync_resolve_account(null)'),/permission denied/);await pg.exec('reset role');await pg.exec('set role authenticated');await assert.rejects(pg.query('select * from private.quiz_sync_account_defaults'),/permission denied/);await pg.exec('reset role');
      const inherited=await pg.query("select has_function_privilege('service_role','public.quiz_sync_resolve_account(text)','EXECUTE') as public_execute,has_function_privilege('service_role','private.quiz_sync_resolve_account(text)','EXECUTE') as private_execute");assert.deepEqual(inherited.rows[0],{public_execute:false,private_execute:false});
      await pg.exec('grant usage on schema private to service_role;set role service_role');await assert.rejects(pg.query('select public.quiz_sync_resolve_account(null)'),/permission denied/);await assert.rejects(pg.query('select private.quiz_sync_resolve_account(null)'),/permission denied/);await pg.exec('reset role;revoke usage on schema private from service_role');
      const r=await pg.query("select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='quiz_sync_resolve_account'");assert.equal(r.rows[0].prosecdef,false);
      const policies=await pg.query("select relrowsecurity from pg_class where oid='private.quiz_sync_account_defaults'::regclass");assert.equal(policies.rows[0].relrowsecurity,true);
    });
    await t.test('first resolution and retries return one unpredictable ID and one row per account',async()=>{
      await reset();const initial=await call();assert.equal(initial.code,'ok');assert.equal(initial.created,true);assert.match(initial.syncId,/^[a-f0-9]{36}$/);const attempts=await Promise.all(Array.from({length:5},()=>pg.query('select public.quiz_sync_resolve_account(null) as value')));assert.ok(attempts.every(r=>r.rows[0].value.syncId===initial.syncId));assert.equal((await pg.query('select count(*)::int as count from private.quiz_sync_account_defaults')).rows[0].count,1);
      await auth(b);const other=await call();assert.notEqual(other.syncId,initial.syncId);assert.equal(other.created,true);assert.equal((await pg.query('select count(*)::int as count from public.quiz_sync_data')).rows[0].count,2);
    });
    await t.test('foreign and ownerless IDs are never claimed and neither reveals another account default',async()=>{
      await reset();await seed(foreign,b);await seed(unowned,a,false);await auth(a);assert.deepEqual(await call(foreign),{code:'not_found'});assert.deepEqual(await call(unowned),{code:'not_found'});assert.equal((await pg.query('select count(*)::int as count from private.quiz_sync_account_defaults')).rows[0].count,0);assert.equal((await pg.query('select creator_hash is null as unowned from public.quiz_sync_data where sync_id=$1',[unowned])).rows[0].unowned,true);
    });
    await t.test('one proven owned legacy stream is adopted without changing its payload or timestamps',async()=>{
      await reset();await seed(first);const before=(await pg.query('select data,updated_at from public.quiz_sync_data where sync_id=$1',[first])).rows[0];const result=await call();assert.deepEqual(result,{code:'ok',syncId:first,created:false});assert.deepEqual((await pg.query('select data,updated_at from public.quiz_sync_data where sync_id=$1',[first])).rows[0],before);
    });
    await t.test('multiple owned streams require selection; established defaults never rebind or merge',async()=>{
      await reset();await seed(first);await seed(second);await seed(foreign,b);await auth(a);const pending=await call();assert.equal(pending.code,'selection_required');assert.equal(pending.choices.length,2);assert.ok(pending.choices.every(c=>[first,second].includes(c.syncId)));assert.equal((await pg.query('select count(*)::int as count from private.quiz_sync_account_defaults')).rows[0].count,0);assert.equal((await call(first)).syncId,first);assert.deepEqual(await call(second),{code:'migration_required',syncId:first});assert.equal((await pg.query('select count(*)::int as count from public.quiz_sync_data')).rows[0].count,3);
    });
    await t.test('deleted canonical streams stay deleted; account deletion removes the private mapping',async()=>{
      await reset();const result=await call();await pg.query('delete from public.quiz_sync_data where sync_id=$1',[result.syncId]);assert.deepEqual(await call(),{code:'deleted'});assert.equal((await pg.query('select count(*)::int as count from public.quiz_sync_data')).rows[0].count,0);await pg.query('delete from auth.users where id=$1',[a]);assert.equal((await pg.query('select count(*)::int as count from private.quiz_sync_account_defaults')).rows[0].count,0);await assert.rejects(call(),/quiz_sync_authentication_required/);
    });
    await t.test('anonymous authenticated users, missing users and user_metadata spoofing cannot bypass guards',async()=>{
      await reset();await auth(a,true);await assert.rejects(call(),/quiz_sync_authentication_required/);await auth('33333333-3333-4333-8333-333333333333');await assert.rejects(call(),/quiz_sync_authentication_required/);await auth(a);assert.equal((await call()).code,'ok');const owner=(await pg.query('select user_id from private.quiz_sync_account_defaults')).rows[0].user_id;assert.equal(owner,a);
    });
    await t.test('fresh canonical streams can open V2 immediately and keep the existing rate-limit boundary',async()=>{
      await reset();const result=await call();const meta=(await pg.query('select updated_at from public.quiz_sync_data where sync_id=$1',[result.syncId])).rows[0];const opened=(await pg.query('select private.quiz_sync_v2_open($1,$2) as value',[result.syncId,meta.updated_at])).rows[0].value;assert.deepEqual(opened,{code:'ok',revision:0});assert.equal((await pg.query("select count(*)::int as count from private.qa_rate_checks where action='account_resolve'")).rows[0].count,1);await pg.query("select set_config('test.rate_limited','true',false)");await assert.rejects(call(),/rate_limited/);
    });
  }finally{await pg.close()}
});
