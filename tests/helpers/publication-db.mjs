import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
export const publicationOwner='00000000-0000-4000-8000-000000000001';
export async function createPublicationDatabase() {
  const pg=await PGlite.create();
  await pg.exec(`create role anon;create role authenticated;create schema auth;create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
    create function public.delete_quiz_account() returns void language sql as $$ select $$;
    grant usage on schema auth,extensions to anon,authenticated;
    create function extensions.gen_random_bytes(n integer) returns bytea language sql as $$ select decode(substr(repeat(md5(random()::text),n),1,n*2),'hex') $$;
    select set_config('test.user','${publicationOwner}',false);`);
  for(const file of ['20260806_create_collaboration_mvp.sql','20260807_add_group_member_management.sql','20260814163631_secure_collaboration_rpc_only.sql','20260909105403_publish_random_choices.sql','20260909115328_shared_folder_paths.sql','20260909135603_move_published_set_folder.sql','20260909144728_multi_destination_publishing.sql','20260909105552_shared_read_fail_closed.sql','20261002113543_quiz_publication_versions_and_group_progress.sql']) {
    let sql=await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8');
    sql=sql.replace('create extension if not exists pgcrypto;','');
    try {await pg.exec(sql);} catch(error) {await pg.close();throw new Error(`${file}: ${error.message}`);}
  }
  await pg.query('insert into auth.users(id,email) values($1,$2)',[publicationOwner,'owner@example.test']);
  return pg;
}
export function publicationQuestions(count) {return Array.from({length:count},(_,position)=>({logical_id:`q-${position}`,position,question:`Vocabulary ${position}: choose the meaning.`,choices:['A','B','C','D'],answer_indexes:[0],answer_text:'A',explanation:'Explanation '.repeat(20),detailed_explanation:'Details '.repeat(20),source_page:'',category:'English',difficulty:'basic',distractors:[],shuffle_choices:null}));}
export function publicationMetadata(localId='fixture') {return {local_set_id:localId,title:'Vocabulary fixture',author_name:'Owner',description:'Fixture',audience:'Test',visibility:'public',add_destinations:true,group_ids:[]};}
export async function publicationCall(pg,name,values,types) {return (await pg.query(`select public.${name}(${values.map((_,i)=>`$${i+1}::${types[i]}`).join(',')}) result`,values)).rows[0].result;}
