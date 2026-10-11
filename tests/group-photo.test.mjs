import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {isGroupPhoto} from '../src/utils/groupPhoto.ts';
const pg=await PGlite.create();after(()=>pg.close());
const owner='00000000-0000-4000-8000-000000000001',admin='00000000-0000-4000-8000-000000000002',group='10000000-0000-4000-8000-000000000001';
await pg.exec(`create role anon;create role authenticated;create schema auth;create schema quiz_private;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.user',true),'')::uuid$$;
create table public.quiz_groups(id uuid primary key,owner_id uuid,name text,icon text default 'group',accent text default 'blue',updated_at timestamptz default now());
create table public.quiz_group_members(group_id uuid,user_id uuid,role text);
create table public.quiz_group_problem_sets(group_id uuid);
insert into public.quiz_groups(id,owner_id,name) values('${group}','${owner}','Study');
insert into public.quiz_group_members values('${group}','${owner}','owner'),('${group}','${admin}','admin');
grant usage on schema quiz_private,auth to authenticated;grant execute on function auth.uid() to authenticated;`);
await pg.exec(await readFile(new URL('../supabase/migrations/20261011141405_group_photo_icons.sql',import.meta.url),'utf8'));
const actor=async id=>pg.query("select set_config('test.user',$1,false)",[id]);
test('owner photo is shared with members and original group data remains',async()=>{
 await actor(owner);await pg.query('select public.quiz_group_photo($1,$2)',[group,'data:image/jpeg;base64,/9j/AA==']);
 await actor(admin);const result=(await pg.query('select public.list_my_groups() result')).rows[0].result;
 assert.equal(result[0].photo,'data:image/jpeg;base64,/9j/AA==');assert.equal(result[0].name,'Study');assert.equal(result[0].member_count,2);
});
test('admin and anonymous cannot change photo or bypass owner protection',async()=>{
 await actor(admin);await assert.rejects(pg.query('select public.quiz_group_photo($1,$2)',[group,null]),/not authorized/);
 await assert.rejects(pg.query("update public.quiz_groups set icon='book' where id=$1",[group]),/not authorized/);
 await pg.exec('set role anon');await assert.rejects(pg.query('select public.quiz_group_photo($1,$2)',[group,null]),/permission denied/);await pg.exec('reset role');
});
test('unsafe or oversized images are rejected; owner can remove a photo',async()=>{
 assert.equal(isGroupPhoto('data:image/svg+xml;base64,AAAA'),false);assert.equal(isGroupPhoto('https://example.test/private'),false);
 await actor(owner);await assert.rejects(pg.query('select public.quiz_group_photo($1,$2)',[group,'data:image/jpeg;base64,'+'A'.repeat(100001)]),/invalid group photo/);
 await pg.query('select public.quiz_group_photo($1,$2)',[group,null]);assert.equal((await pg.query('select photo from public.quiz_groups')).rows[0].photo,null);
});
