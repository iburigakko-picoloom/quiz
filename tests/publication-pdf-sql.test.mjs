import assert from 'node:assert/strict';import {test,after} from 'node:test';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {createPublicationDatabase,publicationCall as call,publicationMetadata,publicationQuestions,publicationOwner as owner} from './helpers/publication-db.mjs';
const pg=await createPublicationDatabase();after(()=>pg.close());
for(const file of ['20261008151820_resumable_publication.sql','20261008172607_public_discovery.sql','20261009110333_public_catalog_soft_delete.sql','20261009001541_public_discovery_reader_authorization.sql','20261011152034_publication_owner_read_identity.sql'])await pg.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
await pg.exec(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant select,insert,update,delete on storage.objects to anon,authenticated;`);
await pg.exec(await readFile(new URL('../supabase/migrations/20261011165511_publication_pdf_materials.sql',import.meta.url),'utf8'));
const reader='00000000-0000-4000-8000-000000000002';await pg.query('insert into auth.users(id,email)values($1,$2)',[reader,'reader@example.test']);
const material=(hash)=>({id:'pdf',title:'Fixture.pdf',pages:[{id:'page',kind:'pdf',pdfPage:1}],pdf:{path:owner+'/'+hash.repeat(64)+'.pdf',sha256:hash.repeat(64),size:32}});
async function actor(id,role='authenticated'){await pg.exec('reset role');await pg.query("select set_config('test.user',$1,false)",[id??'']);await pg.exec('set role '+role);}
async function start(meta,refs=true){const id=randomUUID();await call(pg,'quiz_publish_begin',[id,JSON.stringify(meta),1,'a'.repeat(64)],['uuid','jsonb','integer','text']);const qs=publicationQuestions(1);if(refs)qs[0].material_references=[{materialId:'pdf',pageId:'page'}];await call(pg,'quiz_publish_part',[id,0,JSON.stringify(qs)],['uuid','integer','jsonb']);return id;}
async function upload(m){await pg.query("insert into storage.objects(bucket_id,name,metadata)values('quiz-publication-pdfs',$1,$2)",[m.pdf.path,JSON.stringify({size:32,mimetype:'application/pdf'})]);}
const finish=id=>call(pg,'quiz_publish_finish',[id],['uuid']);
const read=s=>call(pg,'quiz_publication_material_read',[s.id,s.version_id,s.path,null],['uuid','uuid','text','text']);
let published,linked,groupSet,group;
test('PDF and page references must be present before atomic completion; metadata survives immutable version reads',async()=>{
 await actor(owner);const m=material('a'),id=await start({...publicationMetadata('pdf-public'),materials:[m]});await assert.rejects(finish(id),/publication_pdf_missing/);assert.equal((await pg.query('select count(*)::int n from public.shared_problem_sets')).rows[0].n,0);
 await upload(m);const result=await finish(id);published={...result.result,path:m.pdf.path};assert.deepEqual(await finish(id),result);
 const detail=await call(pg,'get_shared_problem_set_versioned',[published.id,null],['uuid','text']);assert.deepEqual(detail.materials,[m]);assert.equal(detail.questions[0].material_references[0].pageId,'page');assert.equal(detail.local_set_id,'pdf-public');
 const bad=await start({...publicationMetadata('bad-ref'),materials:[m]},false);await pg.exec('reset role');await pg.query("update private.quiz_publish_questions set question=question||'{\"material_references\":[{\"materialId\":\"pdf\",\"pageId\":\"missing\"}]}'::jsonb where job_id=$1",[bad]);await actor(owner);await assert.rejects(finish(bad),/publication_invalid_material_reference/);
});
test('only published PDF objects are anonymously readable; uploads cannot target others or overwrite shared bytes',async()=>{
 await actor(owner);const other=material('b');await upload(other);await actor(null,'anon');assert.equal((await pg.query('select name from storage.objects')).rows.length,1);assert.equal(await read(published),true);await assert.rejects(read({...published,path:other.pdf.path}),/not authorized/);
 await actor(reader);await assert.rejects(upload(material('c')),/row-level security/);assert.equal((await pg.query("update storage.objects set metadata='{}' returning name")).rows.length,0);assert.equal((await pg.query('delete from storage.objects returning name')).rows.length,0);
});
test('link PDFs require exact token and authenticated viewer; unpublish immediately blocks new public access',async()=>{
 await actor(owner);const m=material('b'),id=await start({...publicationMetadata('pdf-link'),visibility:'link',materials:[m]});linked={...(await finish(id)).result,path:m.pdf.path};await actor(null,'anon');await assert.rejects(read(linked),/not authorized/);
 await actor(reader);await assert.rejects(read(linked),/not authorized/);await assert.rejects(call(pg,'quiz_publication_material_read',[linked.id,linked.version_id,linked.path,'wrong'],['uuid','uuid','text','text']),/not authorized/);
 await pg.exec('reset role');const token=(await pg.query('select share_token from public.shared_problem_sets where id=$1',[linked.id])).rows[0].share_token;await actor(reader);assert.equal(await call(pg,'quiz_publication_material_read',[linked.id,linked.version_id,linked.path,token],['uuid','uuid','text','text']),true);assert.equal((await pg.query('select name from storage.objects where name=$1',[linked.path])).rows.length,1);
 await pg.exec('reset role');await pg.query("update public.shared_problem_sets set visibility='link' where id=$1",[published.id]);await actor(null,'anon');assert.equal((await pg.query('select name from storage.objects where name=$1',[published.path])).rows.length,0);
});
test('group PDFs allow current members only, and removing membership revokes subsequent access',async()=>{
 await actor(owner);group=(await call(pg,'create_quiz_group',['PDF fixture'],['text'])).id;const m=material('c');await upload(m);const id=await start({...publicationMetadata('pdf-group'),visibility:'group',group_ids:[group],materials:[m]});groupSet={...(await finish(id)).result,path:m.pdf.path};
 await pg.exec('reset role');await pg.query("insert into public.quiz_group_members(group_id,user_id,role)values($1,$2,'member')",[group,reader]);await actor(reader);assert.equal(await read(groupSet),true);await pg.exec('reset role');await pg.query('delete from public.quiz_group_members where group_id=$1 and user_id=$2',[group,reader]);await actor(reader);await assert.rejects(read(groupSet),/not authorized/);assert.equal((await pg.query('select name from storage.objects where name=$1',[groupSet.path])).rows.length,0);
});
test('public folder access includes its PDF and folder unpublish revokes anonymous access',async()=>{
 await actor(owner);const folder=await call(pg,'quiz_public_folder_manage',['save',null,JSON.stringify({name:'PDF folder',local_folder_id:'pdf-folder'}),null,'[]'],['text','uuid','jsonb','uuid','jsonb']);
 await call(pg,'quiz_public_folder_manage',['add',folder,'{}',linked.id,'[]'],['text','uuid','jsonb','uuid','jsonb']);await call(pg,'quiz_public_folder_manage',['publish',folder,'{}',null,'[]'],['text','uuid','jsonb','uuid','jsonb']);
 await actor(null,'anon');assert.equal(await read(linked),true);await actor(owner);await call(pg,'quiz_public_folder_manage',['unpublish',folder,'{}',null,'[]'],['text','uuid','jsonb','uuid','jsonb']);await actor(null,'anon');await assert.rejects(read(linked),/not authorized/);
});
test('PDF metadata changes create one immutable version and identical retries reuse it',async()=>{
 await actor(owner);const m={...material('a'),title:'Revised PDF title'},id=await start({...publicationMetadata('pdf-public'),materials:[m]});const next=(await finish(id)).result;assert.notEqual(next.version_id,published.version_id);
 const old=await call(pg,'quiz_get_publication_version',[published.id,published.version_id,null],['uuid','uuid','text']);assert.equal(old.materials[0].title,'Fixture.pdf');
 const repeat=await start({...publicationMetadata('pdf-public'),materials:[m]});assert.equal((await finish(repeat)).result.version_id,next.version_id);await pg.exec('reset role');assert.equal((await pg.query('select count(*)::int n from private.quiz_publication_versions where set_id=$1',[published.id])).rows[0].n,2);
});
