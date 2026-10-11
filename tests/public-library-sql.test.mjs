import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPublicationDatabase,publicationCall as call,publicationMetadata,publicationQuestions,publicationOwner} from './helpers/publication-db.mjs';
import {publicationSourceFromSnapshot} from '../src/utils/groupStudySource.ts';
const pg=await createPublicationDatabase();after(()=>pg.close());
await pg.exec(await readFile(new URL('../supabase/migrations/20261008151820_resumable_publication.sql',import.meta.url),'utf8'));
const publish=async(local,visibility='link',extra={})=>call(pg,'publish_problem_set_versioned',[JSON.stringify({...publicationMetadata(local),visibility,subject:'Medicine',audience:'CBT',...extra}),JSON.stringify(publicationQuestions(4))],['jsonb','jsonb']);
const legacy=await publish('legacy','public',{folder_path:[{id:'legacy-folder',name:'Legacy'},{id:'child',name:'Child'}]}),hidden=await publish('hidden');
await pg.exec(await readFile(new URL('../supabase/migrations/20261008172607_public_discovery.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261009110333_public_catalog_soft_delete.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../supabase/migrations/20261009001541_public_discovery_reader_authorization.sql',import.meta.url),'utf8'));
const snapshot=row=>({id:row.id,ownerId:row.owner_id,localSetId:row.local_set_id??'',versionId:row.version_id,questions:row.questions.map(q=>({...q,logicalId:q.logical_id}))});
const brokenOwnerRead=await call(pg,'get_shared_problem_set_versioned',[hidden.id,null],['uuid','text']);
assert.throws(()=>publicationSourceFromSnapshot(snapshot(brokenOwnerRead),publicationOwner,'hidden'),/所有者/);
await pg.exec(await readFile(new URL('../supabase/migrations/20261011152034_publication_owner_read_identity.sql',import.meta.url),'utf8'));
const search=(query='',kind='all',category='',min=0,max=null,sort='popular',offset=0)=>call(pg,'quiz_public_search',[query,kind,category,min,max,sort,offset,30],['text','text','text','integer','integer','text','integer','integer']);
const manage=(action,id=null,meta={},set=null,path=[])=>call(pg,'quiz_public_folder_manage',[action,id,JSON.stringify(meta),set,JSON.stringify(path)],['text','uuid','jsonb','uuid','jsonb']);
const folder=id=>call(pg,'quiz_public_folder',[id],['uuid']);
let own;

test('completed publication binds the real authorized owner snapshot to the device without exposing the identity to other readers',async()=>{
  await pg.exec('set role authenticated');
  try{
    const detail=await call(pg,'get_shared_problem_set_versioned',[hidden.id,null],['uuid','text']);
    assert.equal(detail.local_set_id,'hidden');assert.equal(detail.version_id,hidden.version_id);
    assert.equal(detail.share_token,undefined);assert.equal(detail.questions.length,4);
    const source=publicationSourceFromSnapshot(snapshot(detail),publicationOwner,'hidden');
    assert.equal(source.setId,hidden.id);assert.equal(source.manifest.length,4);
    assert.equal(await call(pg,'get_shared_problem_set_versioned',[crypto.randomUUID(),null],['uuid','text']),null);
  }finally{await pg.exec('reset role');}
});

test('a signed-in nonowner cannot read a private set or obtain device IDs through public or link-token reads',async()=>{
  const reader='00000000-0000-4000-8000-000000000003';
  await pg.query('insert into auth.users(id,email) values($1,$2)',[reader,'reader@example.test']);
  await pg.query("select set_config('test.user',$1,false)",[reader]);await pg.exec('set role authenticated');
  try{
    await assert.rejects(call(pg,'get_shared_problem_set_versioned',[hidden.id,null],['uuid','text']),/not authorized/);
    for(const [id,token] of [[legacy.id,null],[hidden.id,hidden.share_token]]){
      const detail=await call(pg,'get_shared_problem_set_versioned',[id,token],['uuid','text']);
      assert.equal(detail.local_set_id,undefined);assert.equal(detail.share_token,undefined);assert.equal(detail.questions.length,4);
    }
  }finally{await pg.exec('reset role');await pg.query("select set_config('test.user',$1,false)",[publicationOwner]);}
});
test('legacy public folders migrate without changing standalone visibility or child paths',async()=>{
  const found=await search();assert.equal(found.folders[0].name,'Legacy');assert.ok(found.folders[0].tags.includes('CBT'));assert.equal(found.folders[0].category,'Medicine');const detail=await folder(found.folders[0].id);assert.deepEqual(detail.members[0].member_path,[{id:'child',name:'Child'}]);assert.equal((await pg.query('select visibility from public.shared_problem_sets where id=$1',[legacy.id])).rows[0].visibility,'public');assert.ok(!found.sets.some(s=>s.id===hidden.id));
});
test('folder publication and standalone visibility are independent and search deduplicates multiple paths',async()=>{
  own=await manage('save',null,{local_folder_id:'own',name:'CBT folder',description:'Heart',category:'Medicine',tags:['Clinical'],pending_set_ids:['hidden']});
  await manage('add',own,{},hidden.id);assert.ok(!(await search()).sets.some(s=>s.id===hidden.id));await manage('ready',own);
  assert.equal((await pg.query('select visibility from public.shared_problem_sets where id=$1',[hidden.id])).rows[0].visibility,'link');
  const other=await manage('save',null,{local_folder_id:'second',name:'Second'});await manage('add',other,{},hidden.id);await manage('publish',other);
  assert.equal((await search()).sets.filter(s=>s.id===hidden.id).length,1);await call(pg,'quiz_public_set_visibility',[hidden.id,true],['uuid','boolean']);await call(pg,'quiz_public_set_visibility',[hidden.id,false],['uuid','boolean']);assert.ok((await search()).sets.some(s=>s.id===hidden.id));
  await manage('unpublish',other);await manage('unpublish',own);assert.ok(!(await search()).sets.some(s=>s.id===hidden.id));await manage('publish',own);
});
test('name, description, author, category, tags and question ranges filter on the server',async()=>{
  assert.equal((await search('Clinical','folder')).folders[0].id,own);assert.equal((await search('Heart','folder')).folders.length,1);assert.equal((await search('CBT','set','Medicine',4,4,'updated')).sets.length,2);assert.equal((await search('','all','',5)).sets.length,0);assert.equal((await search('unknown')).sets.length,0);
});
test('anonymous read APIs never expose drafts, tokens, local IDs or learning progress',async()=>{
  const draft=await manage('save',null,{local_folder_id:'draft',name:'Private draft'});await pg.query("select set_config('test.user','',false)");await pg.exec('set role anon');
  try{const found=await search();assert.ok(!found.folders.some(f=>f.id===draft));await assert.rejects(folder(draft),/not authorized/);const detail=await call(pg,'get_shared_problem_set_versioned',[hidden.id,null],['uuid','text']);assert.equal(detail.questions.length,4);assert.equal(detail.local_set_id,undefined);assert.equal(detail.share_token,undefined);assert.ok(!JSON.stringify(found).includes('share_token'));assert.ok(!JSON.stringify(found).includes('local_set_id'));assert.ok(!JSON.stringify(detail).includes('members'));await assert.rejects(manage('unpublish',own),/permission denied/);await assert.rejects(pg.query('select * from private.quiz_public_folders'),/permission denied/);}finally{await pg.exec('reset role');await pg.query("select set_config('test.user',$1,false)",[publicationOwner]);}
});
test('a different signed-in account cannot add, edit, remove or change visibility of another owner content',async()=>{
  const other='00000000-0000-4000-8000-000000000002';await pg.query('insert into auth.users(id,email) values($1,$2)',[other,'other@example.test']);await pg.query("select set_config('test.user',$1,false)",[other]);
  try{for(const action of ['add','remove','unpublish','publish'])await assert.rejects(manage(action,own,{},hidden.id),/not authorized/);await assert.rejects(manage('save',own,{local_folder_id:'own',name:'Changed'}),/not authorized/);await assert.rejects(call(pg,'quiz_public_set_visibility',[hidden.id,true],['uuid','boolean']),/not authorized/);}finally{await pg.query("select set_config('test.user',$1,false)",[publicationOwner]);}
});
test('public copies count real distinct importers, are idempotent, and folder-only copies are authorized',async()=>{
  const installation=randomUUID();for(let i=0;i<2;i++)await call(pg,'quiz_public_record_import',[hidden.id,installation,'copied'],['uuid','uuid','text']);assert.equal((await folder(own)).import_count,1);assert.equal((await search()).sets.find(s=>s.id===hidden.id).import_count,1);
  const detail=await call(pg,'get_shared_problem_set_versioned',[hidden.id,null],['uuid','text']);assert.equal(detail.import_count,1);assert.equal(detail.questions.length,4);
  const unknown=await publish('not-public');await assert.rejects(call(pg,'quiz_public_record_import',[unknown.id,randomUUID(),'copied'],['uuid','uuid','text']),/not authorized/);
});
test('adding to public folders preserves existing group visibility and group links during content publication',async()=>{
  const group=await call(pg,'create_quiz_group',['Group'],['text']);const initial=await publish('group-owned','group',{group_ids:[group.id]});
  const next=await publish('group-owned','link',{keep_visibility:true,add_destinations:true});assert.equal(next.visibility,'group');assert.equal(next.version_id,initial.version_id);assert.equal((await pg.query('select count(*)::int n from public.quiz_group_problem_sets where set_id=$1',[initial.id])).rows[0].n,1);
});

test('an incomplete folder stays private and a late ready callback cannot undo explicit unpublication',async()=>{
  const draft=await manage('save',null,{local_folder_id:'pending',name:'Pending',pending_set_ids:['hidden','not-yet-published']});await manage('add',draft,{},hidden.id);await manage('ready',draft);assert.equal((await folder(draft)).published,false);
  await manage('unpublish',draft);await manage('ready',draft);assert.equal((await folder(draft)).published,false);
  const privateDraft=await manage('save',null,{local_folder_id:'private',name:'Private'});await manage('add',privateDraft,{},hidden.id);await manage('ready',privateDraft);assert.equal((await folder(privateDraft)).published,false);
});
