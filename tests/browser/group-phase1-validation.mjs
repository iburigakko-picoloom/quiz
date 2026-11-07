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
const errors=[];
try {
  await new Promise((resolveReady,reject)=>{const timeout=setTimeout(()=>reject(new Error('Test server timed out')),15000);server.stdout.on('data',chunk=>{if(chunk.toString().includes('5175')){clearTimeout(timeout);resolveReady();}});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Test server exited: ${code}`));});});
  browser=await chromium.launch({channel:'chrome',headless:true});
  page=await browser.newPage({viewport:{width:390,height:844}});
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const userId='00000000-0000-4000-8000-000000000001';
  const user={id:userId,aud:'authenticated',role:'authenticated',email:'preview@example.test',is_anonymous:false,user_metadata:{},app_metadata:{},created_at:new Date().toISOString()};
  const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.test`;
  await page.addInitScript(({user,token})=>localStorage.setItem('sb-group-preview-auth-token',JSON.stringify({access_token:token,refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{user,token});
  const state=structuredClone(previewSnapshot);state.members[0].userId=userId;state.folders[0].createdBy=userId;
  const sets=structuredClone(previewSets);
  const snakeSet=set=>({id:set.id,local_set_id:set.localSetId,owner_id:set.ownerId==='you'?userId:set.ownerId,author_name:set.authorName,title:set.title,description:set.description,subject:set.subject,audience:set.audience,difficulty:set.difficulty,creation_method:set.creationMethod,source:set.source,visibility:set.visibility,question_count:set.questionCount,add_count:set.addCount,import_count:set.importCount,published_at:set.publishedAt,updated_at:set.updatedAt,version_id:set.versionId,folder_path:set.folderPath??[],questions:set.questions?.map((q,i)=>({position:i,logical_id:q.logicalId,content_revision:'preview',question:q.question,choices:q.choices,answer_indexes:q.answerIndexes,answer_text:q.answerText,explanation:q.explanation,detailed_explanation:q.detailedExplanation,source_page:q.sourcePage,category:q.category,difficulty:q.difficulty}))});
  const snapshot=()=>({icon:state.icon,accent:state.accent,folders:state.folders.map(f=>({id:f.id,name:f.name,parent_folder_id:f.parentId,created_by:f.createdBy,creator_name:f.creatorName,created_at:f.createdAt,updated_at:f.updatedAt,import_count:f.importCount})),placements:state.placements.map(p=>({set_id:p.setId,group_folder_id:p.folderId})),members:state.members.map(m=>({user_id:m.userId,display_name:m.displayName,role:m.role,levels:m.levels,today_count:m.todayCount,week_count:m.weekCount,imported_set_count:m.importedSetCount,shared_set_count:m.sharedSetCount}))});
  const mutations=[];const uploads=new Map();const sourceConsents=new Map();page.on('pageerror',error=>errors.push(error.message));
  let activityEnabled=false,failActivity=true,manyActivities=false; const postedActivities=new Map();
  const batch = () => sets.map(set=>({set_id:set.id,version_id:set.versionId,learners:1,answered:3,total:45,levels:[42,1,1,1],reflected_at:new Date().toISOString(),today_count:2,week_count:5,own_enabled:false,own_copy_id:null,own_state:'not_shared',own_reflected_at:null}));
  await page.route('https://group-preview.example.test/**',async route=>{
    const request=route.request(),url=new URL(request.url()),name=url.pathname.split('/').at(-1);
    requests.push(name);
    const args=request.postDataJSON();let result;
    if(url.pathname==='/auth/v1/user') result=user;
    else if(name==='quiz_profiles') result={display_name:'検証ユーザー'};
    else if(name==='list_my_groups') result=[{id:previewGroup.id,name:previewGroup.name,role:'owner',icon:state.icon,accent:state.accent,member_count:8,set_count:sets.length}];
    else if(name==='list_my_published_sets'||name==='list_public_problem_sets'||name==='shared_problem_sets') result=[];
    else if(name==='list_group_problem_sets') result=sets.map(s=>({...snakeSet(s),questions:undefined}));
    else if(name==='list_quiz_group_members') result=state.members.map(m=>({user_id:m.userId,display_name:m.displayName,role:m.role}));
    else if(name==='quiz_group_learning_read') result=snapshot();
    else if(name==='quiz_group_material_progress') result=batch();
    else if(name==='quiz_group_activity_read') result={enabled:activityEnabled,generation:activityEnabled?'generation':null,entries:(manyActivities?Array.from({length:65},(_,i)=>({id:String(65-i),user_id:'sato',display_name:'佐藤',set_id:'set-0',title:`心不全 ${65-i}`,finished_at:new Date().toISOString(),answered:3})):[{id:'1',user_id:'sato',display_name:'佐藤',set_id:'set-0',title:'心不全',finished_at:new Date().toISOString(),answered:3}]).filter(row=>!args.p_before||Number(row.id)<Number(args.p_before)).slice(0,50)};
    else if(name==='quiz_group_activity_consent'){activityEnabled=args.p_enabled;result=true;}
    else if(name==='quiz_group_activity_destinations')result=activityEnabled?[{group_id:'preview-group',generation:'generation',enabled_at:'2026-01-01T00:00:00Z'}]:[];
    else if(name==='record_problem_set_copy')result=true;
    else if(name==='quiz_group_activity_publish'){
      if(failActivity){failActivity=false;await route.fulfill({status:503,body:'offline'});return;}
      assert.deepEqual(Object.keys(args).sort(),['p_group_id','p_generation','p_event_id','p_set_id','p_version_id','p_copy_id','p_started_at','p_finished_at','p_answered'].sort());
      postedActivities.set(args.p_event_id,args);result=true;
    }
    else if(name==='get_shared_problem_set_versioned')result=snakeSet(sets.find(set=>set.id===args.p_set_id));
    else if(name==='quiz_group_learning_set_read') result={version_id:'version-0',own:{generation:null,enabled:false,copy_id:null,version_id:null},members:[
      {user_id:'sato',display_name:'佐藤',state:'shared',imported:true,answered:3,total:45,reflected_at:new Date().toISOString(),levels:[42,1,1,1]},
      {user_id:'private',display_name:'非共有の利用者',state:'not_shared',imported:true,answered:null,total:null,reflected_at:null,levels:null}]};
    else {errors.push(name);await route.fulfill({status:500,body:'unexpected request'});return;}
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto('http://127.0.0.1:5175/quiz/tests/browser/group-community-preview.html',{waitUntil:'domcontentloaded'});
  await page.locator('.group-material-card').first().waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['タイムライン','フォルダ','メンバー','概要']);
  assert.equal(await page.getByRole('tab',{name:'概要',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(requests.filter(n=>n==='quiz_group_material_progress').length,1);
  assert.equal(requests.filter(n=>n==='get_shared_problem_set_versioned').length,0);
  await mkdir('qa/phase1',{recursive:true});
  await page.screenshot({path:'qa/phase1/overview-390.png'});
  await page.locator('.group-material-card').first().click();
  await page.getByRole('heading',{name:'教材の進捗',exact:true}).waitFor();
  await page.getByRole('button',{name:'グループ全体',exact:true}).click();
  await page.getByText('回答済み 3 / 45問・回答率 7%',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'取り込む',exact:true}).count(),0);
  assert.equal(await page.getByText('非共有の利用者',{exact:true}).count(),0);
  assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');
  assert.equal(requests.filter(n=>n==='quiz_group_progress_consent').length,0);
  await page.screenshot({path:'qa/phase1/progress-390.png'});
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  assert.equal(await page.getByRole('tab',{name:'概要',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'タイムライン',exact:true}).click();
  await page.getByRole('button',{name:'活動を共有する',exact:true}).click();
  await page.getByRole('button',{name:'同意して共有',exact:true}).click();
  await page.getByRole('button',{name:'活動共有を停止',exact:true}).waitFor();
  assert.equal(activityEnabled,true);
  await page.screenshot({path:'qa/phase1/timeline-390.png'});
  await page.getByRole('button',{name:'心不全',exact:true}).click();
  await page.getByRole('heading',{name:'教材の進捗',exact:true}).waitFor();
  // Exercise the exact handler used by Android/app back and browser popstate.
  assert.equal(await page.evaluate(async()=>{const {tryScreenBack}=await import('/quiz/src/utils/screenBack.ts');return tryScreenBack();}),true);
  await page.getByRole('tab',{name:'タイムライン',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'タイムライン',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'フォルダ',exact:true}).click();
  await page.locator('.group-folder-list .library-content-row__open').first().click();
  await page.getByRole('button',{name:'フォルダごと取り込む',exact:true}).waitFor();
  await page.locator('.group-set-list .library-content-row__open').first().click();
  await page.getByRole('button',{name:'取り込む',exact:true}).waitFor();
  assert.equal(await page.getByRole('switch').count(),0);
  assert.equal(await page.locator('.group-set-progress').count(),0);
  await page.screenshot({path:'qa/phase1/import-390.png'});
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  await page.getByRole('tab',{name:'メンバー',exact:true}).click();
  assert.equal(await page.locator('.group-member-card').count(),6);
  await page.getByText('メンバーを管理',{exact:true}).click();
  assert.ok(await page.getByRole('button',{name:'メンバーから外す',exact:true}).count()>0);
  for(const width of [390,768]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  manyActivities=true;
  await page.getByRole('tab',{name:'タイムライン',exact:true}).click();
  await page.getByRole('button',{name:'もっと見る',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.group-timeline article').length===65);
  await page.evaluate(()=>window.dispatchEvent(new Event('quizmake:group-activity-updated')));
  await page.waitForResponse(response=>response.url().endsWith('/rpc/quiz_group_activity_read')&&response.request().postDataJSON()?.p_before==='16');
  assert.equal(await page.locator('.group-timeline article').count(),65,'refresh preserves loaded history pages');
  manyActivities=false;
  const submitSession=()=>page.evaluate(async()=>{
    const {queueCompletedStudy}=await import('/quiz/src/utils/groupActivityService.ts');
    const {questionRevision}=await import('/quiz/src/utils/studyPlans.ts');
    const q={id:'activity-q',setId:'activity-copy',question:'private question',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'private explanation',category:'',sourcePage:'',difficulty:'basic'};
    const rev=questionRevision(q);q.origin={setId:'set-0',publicationVersionId:'version-0',logicalId:'logical',contentRevision:'remote-revision',importedContent:rev};
    const data={version:1,folders:[],problemSets:[{id:'activity-copy',sourceSetId:'set-0',sourceVersionId:'version-0',sourceManifest:[{logicalId:'logical',contentRevision:'remote-revision'}]}],questions:[q],progress:[],answerLogs:[{id:'durable-answer-id',questionId:q.id,setId:q.setId,questionRevision:rev,answeredAt:'2026-11-07T12:00:00Z'}]};
    try{await queueCompletedStudy(data,{sessionAnswers:[{answerLogId:'durable-answer-id'}]});return 'sent';}catch{return 'pending';}
  });
  assert.equal(await submitSession(),'pending');
  await page.evaluate(async()=>{const {retryStudyActivities}=await import('/quiz/src/utils/groupActivityService.ts');await retryStudyActivities();});
  assert.equal(postedActivities.size,1);
  assert.equal(await submitSession(),'sent');assert.equal(postedActivities.size,1,'same restored result deduplicates');
  assert.equal([...postedActivities.values()][0].p_answered,1);
  await page.evaluate(async()=>{
    const {planPublicImport}=await import('/quiz/src/utils/publicImport.ts');
    const {previewData,previewSets}=await import('/quiz/tests/fixtures/group-learning.ts');
    const shared={...previewSets[0],title:'活動テスト教材',questionCount:1,questions:[{...previewSets[0].questions[0],contentRevision:'activity-revision'}],standalonePublic:false,tags:[]};
    const plan=planPublicImport(previewData,[shared],{groupFolder:{groupId:'preview-group',key:'test',name:'活動テストフォルダ'}});
    localStorage.setItem('publication-preview-data-source',JSON.stringify(plan.data));
  });
  await page.goto('http://127.0.0.1:5175/quiz/tests/browser/group-community-preview.html?exercise=1',{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:/活動テストフォルダ/}).first().click();
  await page.getByRole('button',{name:/活動テスト教材/}).first().click();
  await page.getByRole('button',{name:'登録順で解く',exact:true}).click();
  await page.locator('.quiz-choice__text').filter({hasText:/^選択肢A$/}).click();
  await page.getByRole('button',{name:'解答する',exact:true}).click();
  const activityPosted=page.waitForResponse(response=>response.url().endsWith('/rpc/quiz_group_activity_publish'));
  await page.getByRole('button',{name:'結果へ',exact:true}).click();
  assert.equal((await activityPosted).status(),200);
  await page.getByRole('heading',{name:'学習結果',exact:true}).waitFor();
  assert.equal(postedActivities.size,2,'Full App publishes one activity on session completion');
  // Use the real App history/popstate listener, not only screenBack directly.
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  await page.getByRole('button',{name:'戻る',exact:true}).click();
  await page.getByRole('button',{name:'グループ',exact:true}).click();
  await page.getByRole('button',{name:new RegExp(previewGroup.name)}).first().click();
  await page.locator('.group-material-card').first().waitFor();
  await page.locator('.group-material-card').first().click();
  await page.getByRole('heading',{name:'教材の進捗',exact:true}).waitFor();
  await page.goBack();
  await page.getByRole('tab',{name:'概要',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'概要',exact:true}).getAttribute('aria-selected'),'true','browser back restores overview origin');
  await page.getByRole('tab',{name:'タイムライン',exact:true}).click();
  await page.getByRole('button',{name:'心不全',exact:true}).click();
  await page.getByRole('heading',{name:'教材の進捗',exact:true}).waitFor();
  await page.goBack();
  await page.getByRole('tab',{name:'タイムライン',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'タイムライン',exact:true}).getAttribute('aria-selected'),'true','browser back restores timeline origin');
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState!=='running'));
  await page.screenshot({path:'qa/phase1/timeline-app-history-390.png'});

  assert.deepEqual(errors,[]);
  console.log('PASS: 4 tabs, overview default, constant RPC reads, progress/import separation, consent OFF, private member filtering, both return origins, app back handler and real browser history/popstate origins, mobile/tablet widths, durable activity retry and session deduplication.');
} finally {await browser?.close();server.kill();}
