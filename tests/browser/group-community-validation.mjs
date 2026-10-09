import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {mkdir} from 'node:fs/promises';
import { previewGroup, previewSets, previewSnapshot } from '../fixtures/group-learning.ts';
const packagePath=process.env.QUIZMAKE_PLAYWRIGHT_MODULE;
const {chromium}=await import(packagePath ? pathToFileURL(resolve(packagePath,'index.mjs')).href : 'playwright');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5175','--strictPort'],{cwd:resolve('.'),env:{...process.env,VITE_SUPABASE_URL:'https://group-preview.example.test',VITE_SUPABASE_ANON_KEY:'test-public-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,page;
const requests=[];
try {
  await new Promise((resolveReady,reject)=>{const timeout=setTimeout(()=>reject(new Error('Test server timed out')),15000);server.stdout.on('data',chunk=>{if(chunk.toString().includes('5175')){clearTimeout(timeout);resolveReady();}});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Test server exited: ${code}`));});});
  browser=await chromium.launch({channel:'chrome',headless:true});
  page=await browser.newPage({viewport:{width:390,height:844}});
  page.setDefaultTimeout(10000);
  const userId='00000000-0000-4000-8000-000000000001';
  const user={id:userId,aud:'authenticated',role:'authenticated',email:'preview@example.test',is_anonymous:false,user_metadata:{},app_metadata:{},created_at:new Date().toISOString()};
  const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.test`;
  await page.addInitScript(({user,token})=>localStorage.setItem('sb-group-preview-auth-token',JSON.stringify({access_token:token,refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{user,token});
  const state=structuredClone(previewSnapshot);state.members[0].userId=userId;state.folders[0].createdBy=userId;
  const sets=structuredClone(previewSets);
  const snakeSet=set=>({id:set.id,local_set_id:set.localSetId,owner_id:set.ownerId==='you'?userId:set.ownerId,author_name:set.authorName,title:set.title,description:set.description,subject:set.subject,audience:set.audience,difficulty:set.difficulty,creation_method:set.creationMethod,source:set.source,visibility:set.visibility,question_count:set.questionCount,add_count:set.addCount,import_count:set.importCount,published_at:set.publishedAt,updated_at:set.updatedAt,version_id:set.versionId,folder_path:set.folderPath??[],questions:set.questions?.map((q,i)=>({position:i,logical_id:q.logicalId,content_revision:'preview',question:q.question,choices:q.choices,answer_indexes:q.answerIndexes,answer_text:q.answerText,explanation:q.explanation,detailed_explanation:q.detailedExplanation,source_page:q.sourcePage,category:q.category,difficulty:q.difficulty}))});
  const snapshot=()=>({icon:state.icon,accent:state.accent,folders:state.folders.map(f=>({id:f.id,name:f.name,parent_folder_id:f.parentId,created_by:f.createdBy,creator_name:f.creatorName,created_at:f.createdAt,updated_at:f.updatedAt,import_count:f.importCount})),placements:state.placements.map(p=>({set_id:p.setId,group_folder_id:p.folderId})),members:state.members.map(m=>({user_id:m.userId,display_name:m.displayName,role:m.role,levels:m.levels,today_count:m.todayCount,week_count:m.weekCount,imported_set_count:m.importedSetCount,shared_set_count:m.sharedSetCount}))});
  const mutations=[];const uploads=new Map();const sourceConsents=new Map();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let failPublication=true,holdRestart=true,releaseRestart;
  const blockedRestart=new Promise(resolve=>{releaseRestart=resolve;});
  const partStarts=[];
  await page.route('https://group-preview.example.test/**',async route=>{
    const request=route.request(),url=new URL(request.url()),name=url.pathname.split('/').at(-1);
    requests.push(name);
    const args=request.postDataJSON();let result;
    if(url.pathname==='/auth/v1/user') result=user;
    else if(name==='list_my_groups') result=[{id:previewGroup.id,name:previewGroup.name,role:'owner',icon:state.icon,accent:state.accent,member_count:8,set_count:sets.length}];
    else if(name==='list_my_published_sets'||name==='list_public_problem_sets'||name==='shared_problem_sets') result=[];
    else if(name==='list_group_problem_sets') result=sets.map(s=>({...snakeSet(s),questions:undefined}));
    else if(name==='list_quiz_group_members') result=state.members.map(m=>({user_id:m.userId,display_name:m.displayName,role:m.role}));
    else if(name==='quiz_group_learning_read') result=snapshot();
    else if(name==='get_shared_problem_set_versioned')result=snakeSet(sets.find(set=>set.id===args.p_set_id));
    else if(name==='quiz_group_learning_set_read'){
      const set=sets.find(s=>s.id===args.p_set_id),c=sourceConsents.get(args.p_set_id);
      result={version_id:set.versionId,own:c??{generation:null,enabled:false,copy_id:null,version_id:null},members:[{user_id:userId,display_name:'あなた',state:c?.levels?'shared':'not_shared',imported:Boolean(c?.enabled),answered:c?.levels?c.answered:null,total:c?.levels?set.questionCount:null,reflected_at:c?.levels?new Date().toISOString():null,levels:c?.levels??null}]};
    }
    else if(name==='quiz_group_progress_consent'){const c={generation:'source-consent',enabled:args.p_enabled,copy_id:args.p_copy_id,version_id:args.p_version_id};sourceConsents.set(args.p_set_id,c);mutations.push({name,args});result=c;}
    else if(name==='quiz_group_learning_update'){const c=sourceConsents.get(args.p_set_id);assert.equal(c.copy_id,args.p_copy_id);assert.equal(c.generation,args.p_generation);c.levels=args.p_levels;c.answered=args.p_answered;mutations.push({name,args});result=true;}
    else if(name==='manage_quiz_group_library') {assert.equal(args.p_action,'create');state.folders.push({id:'new-folder',name:args.p_name,parentId:null,createdBy:userId,creatorName:'あなた',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),importCount:0});result='new-folder';mutations.push({name,args});}
    else if(name==='quiz_group_learning_icon') {state.icon=args.p_icon;state.accent=args.p_accent;result=true;mutations.push({name,args});}
    else if(name==='quiz_group_learning_place') {const placement=state.placements.find(p=>p.setId===args.p_set_id);if(placement)placement.folderId=args.p_folder_id;else state.placements.push({setId:args.p_set_id,folderId:args.p_folder_id});result=true;mutations.push({name,args});}
    else if(name==='quiz_profiles') result={display_name:'あなた'};
    else if(name==='quiz_publish_begin'){if(!uploads.has(args.p_job_id))uploads.set(args.p_job_id,{state:'uploading',uploaded:0,total:args.p_total,metadata:args.p_set,questions:[]});result=uploads.get(args.p_job_id);}
    else if(name==='quiz_publish_part'){
      const job=uploads.get(args.p_job_id);partStarts.push({id:args.p_job_id,title:job.metadata.title,start:args.p_start});
      if(job.metadata.title==='通信失敗セット'&&failPublication){await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'57014',message:'canceling statement due to statement timeout'})});return;}
      if(job.metadata.title==='再起動セット'&&args.p_start===250&&holdRestart){holdRestart=false;await blockedRestart;await route.abort().catch(()=>{});return;}
      if(job.uploaded===args.p_start){job.questions.push(...args.p_questions);job.uploaded+=args.p_questions.length;}result=job;
    }
    else if(name==='quiz_publish_status')result=uploads.get(args.p_job_id);
    else if(name==='quiz_publish_finish'){const job=uploads.get(args.p_job_id);if(job.state!=='completed'){const set=job.metadata,id=set.local_set_id==='new-local-set'?'new-cloud-set':`cloud-${set.local_set_id}`;sets.push({id,localSetId:set.local_set_id,ownerId:userId,authorName:set.author_name,title:set.title,description:set.description,subject:set.subject,audience:set.audience,difficulty:set.difficulty,creationMethod:set.creation_method,source:set.source,visibility:set.visibility,questionCount:job.total,addCount:0,importCount:0,publishedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),versionId:`version-${id}`,questions:job.questions.map(q=>({logicalId:q.logical_id,question:q.question,choices:q.choices,answerIndexes:q.answer_indexes,answerText:q.answer_text,explanation:q.explanation,detailedExplanation:q.detailed_explanation,sourcePage:q.source_page,category:q.category,difficulty:q.difficulty,distractors:q.distractors,shuffleChoices:q.shuffle_choices}))});job.state='completed';job.is_current=true;job.result={id,version_id:`version-${id}`,visibility:'group',share_token:'test'};mutations.push({name,args:job.metadata});}result=job;}
    else if(name==='publish_problem_set_versioned') {const set=args.p_set;sets.push({id:'new-cloud-set',localSetId:set.local_set_id,ownerId:userId,authorName:set.author_name,title:set.title,description:set.description,subject:set.subject,audience:set.audience,difficulty:set.difficulty,creationMethod:set.creation_method,source:set.source,visibility:set.visibility,questionCount:args.p_questions.length,addCount:0,importCount:0,publishedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});result={id:'new-cloud-set',version_id:'new-version',visibility:'group',share_token:'test'};mutations.push({name,args});}
    else { errors.push(`Unexpected mock request: ${url.pathname}`);await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'Unexpected test request'})});return; }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto('http://127.0.0.1:5175/quiz/tests/browser/group-community-preview.html?sourcePointer=1');
  await page.getByRole('tab',{name:'フォルダ 3'}).waitFor();
  await page.getByRole('button',{name:'グループアイコンを変更'}).click();
  await page.getByRole('button',{name:'教材',exact:true}).click();await page.getByRole('button',{name:'紫',exact:true}).click();await page.getByRole('button',{name:'アイコンを保存'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(state.icon,'book');assert.equal(state.accent,'violet');
  await page.getByRole('tab',{name:/フォルダ/}).click();await page.getByRole('button',{name:'フォルダを追加'}).click();await page.getByRole('textbox',{name:'フォルダ名'}).fill('病理学');await page.getByRole('button',{name:'追加する',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('tab',{name:'フォルダ 4'}).waitFor();
  await page.locator('.group-folder-card__open').first().click();
  await page.getByRole('button',{name:'問題セットを追加'}).click();await page.getByRole('button',{name:'グループから選ぶ'}).click();await page.getByRole('checkbox',{name:/心電図/}).check();await page.getByRole('button',{name:'次へ（1セット）'}).click();await page.getByRole('button',{name:'フォルダに追加する'}).click();await page.getByText('フォルダに追加済み',{exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await page.locator('.group-set-list .library-content-row__open').count(),4);assert.equal(mutations.filter(m=>m.name==='publish_problem_set_versioned').length,0);
  await page.getByRole('button',{name:'問題セットを追加'}).click();await page.getByRole('checkbox',{name:'追加用セットを選択'}).check();await page.getByRole('button',{name:'次へ（1セット）'}).click();await page.getByRole('button',{name:'フォルダに追加する'}).click();await page.getByText('公開完了',{exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.group-set-list .library-content-row__open').length===5);
  assert.deepEqual(mutations.find(m=>m.name==='quiz_publish_finish').args.group_ids,['preview-group']);assert.equal(state.placements.find(p=>p.setId==='new-cloud-set').folderId,'folder-0');assert.deepEqual(errors,[]);console.log('Real CommunityScreen with isolated RPCs: icon, empty folder, existing-set placement and resumable publication passed');
  const readsBefore=requests.filter(n=>n==='get_shared_problem_set_versioned').length;
  await page.getByRole('tab',{name:'概要',exact:true}).click();await page.getByRole('button',{name:'自分',exact:true}).click();await page.getByRole('img',{name:/進捗、1問、Level0 100%/}).waitFor();
  assert.ok(requests.filter(n=>n==='get_shared_problem_set_versioned').length>readsBefore);assert.equal(mutations.some(m=>m.name==='quiz_group_progress_consent'),false);
  await page.getByRole('tab',{name:/フォルダ/}).click();
  await page.locator('.group-set-list .library-content-row__open').filter({hasText:'追加用セット'}).click();await page.getByRole('button',{name:'共有元を開く',exact:true}).waitFor();
  await mkdir('qa/group-source-screenshots',{recursive:true});await page.screenshot({path:'qa/group-source-screenshots/owner-source-390.png'});
  assert.equal(await page.getByRole('button',{name:'取り込む',exact:true}).count(),0);assert.equal(mutations.some(m=>m.name==='quiz_group_progress_consent'),false);
  await page.getByText(/自分の進捗を共有/).click();await page.getByRole('combobox',{name:'集計する教材'}).waitFor();assert.equal(await page.getByRole('combobox',{name:'集計する教材'}).inputValue(),'new-local-set');
  await page.locator('.community-screen--group-workspace').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.screenshot({path:'qa/group-source-screenshots/owner-before-consent-390.png'});
  await page.getByRole('button',{name:'この教材の集計を共有する',exact:true}).click();await page.getByRole('button',{name:'共有をOFFにする',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'集計する教材'}).inputValue(),'new-local-set');
  assert.equal(sourceConsents.get('new-cloud-set').copy_id,'new-local-set');assert.ok(!requests.includes('record_problem_set_copy'));
  await page.getByRole('button',{name:'共有元を開く',exact:true}).click();assert.equal(await page.locator('body').getAttribute('data-opened-set'),'new-local-set');
  await page.locator('.community-screen--group-workspace').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.screenshot({path:'qa/group-source-screenshots/owner-after-consent-390.png'});console.log('Owner original is automatically linked, no copy is imported, consent remains explicit and source CTA opens the existing local ID');
  await page.goto('http://127.0.0.1:5175/quiz/tests/browser/group-community-preview.html?publication=1');
  await page.getByRole('tab',{name:/フォルダ/}).click();await page.locator('.group-folder-card__open').first().click();
  await page.getByRole('button',{name:'問題セットを追加'}).click();await page.getByRole('checkbox',{name:'公開検証フォルダ内をまとめて選択'}).check();
  await page.getByRole('button',{name:'次へ（3セット）'}).click();await page.getByRole('button',{name:'フォルダに追加する'}).click();
  const row=title=>page.locator('.publication-job').filter({has:page.getByText(title,{exact:true})});
  await row('通信失敗セット').getByText('公開失敗',{exact:true}).waitFor();await row('再起動セット').getByText('250 / 600問',{exact:true}).waitFor();await row('後続セット').getByText('公開待ち',{exact:true}).waitFor();
  assert.ok(!await row('通信失敗セット').innerText().then(t=>t.includes('canceling statement')));
  await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();await row('再起動セット').getByText('公開中',{exact:true}).waitFor();
  await page.reload();releaseRestart();
  await row('再起動セット').getByText('公開完了',{exact:true}).waitFor();await row('後続セット').getByText('公開完了',{exact:true}).waitFor();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('publication-preview-applied')??'[]').includes('publication-local-2'));
  assert.equal(partStarts.filter(p=>p.title==='再起動セット'&&p.start===0).length,1);
  assert.equal(Array.from(uploads.values()).find(j=>j.metadata.title==='再起動セット').questions.length,600);
  const failedId=Array.from(uploads.entries()).find(([,j])=>j.metadata.title==='通信失敗セット')[0];failPublication=false;
  await row('通信失敗セット').getByRole('button',{name:'このセットを再試行'}).click();await row('通信失敗セット').getByText('公開完了',{exact:true}).waitFor();
  assert.equal(Array.from(uploads.entries()).find(([,j])=>j.metadata.title==='通信失敗セット')[0],failedId);
  assert.equal(mutations.filter(m=>m.name==='quiz_publish_finish'&&m.args.local_set_id?.startsWith('publication-local-')).length,3);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('publication-preview-applied')??'[]').filter(id=>id.startsWith('publication-local-')).length===3);
  assert.deepEqual(errors,[]);console.log('Real publication UI: folder batch, four states, per-set retry, close/reload, authoritative 250/600 cursor and exactly-once commit passed');
} catch(error) {console.error('Mock requests:',requests);if(page)console.error('Rendered test screen:',await page.locator('body').innerText());throw error;}
finally {await browser?.close();server.kill();}
