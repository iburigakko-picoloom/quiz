import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5178','--strictPort'],{env:{...process.env,VITE_SUPABASE_URL:'https://latest-preview.example.test',VITE_SUPABASE_ANON_KEY:'fixture'},stdio:['ignore','pipe','pipe'],windowsHide:true});let browser;
try{
 await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Server timeout')),20000);server.stdout.on('data',raw=>{if(raw.toString().includes('5178')){clearTimeout(timer);done();}});server.once('exit',code=>{clearTimeout(timer);fail(Error('Server exit '+code));});});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:866}});page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(45000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const owner='00000000-0000-4000-8000-000000000001',user={id:owner,aud:'authenticated',role:'authenticated',email:'fixture@example.test',user_metadata:{},app_metadata:{},created_at:'2026-10-11T00:00:00Z'},token=`e30.${Buffer.from(JSON.stringify({sub:owner,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`;
 await page.addInitScript(({user,token})=>localStorage.setItem('sb-latest-preview-auth-token',JSON.stringify({user,access_token:token,refresh_token:'fixture',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600})),{user,token});
 const photo=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=120;const ctx=canvas.getContext('2d');ctx.fillStyle='#a8c1cd';ctx.fillRect(0,0,120,120);return canvas.toDataURL('image/jpeg');});
 let savedPhoto=photo;
 await page.route('https://latest-preview.example.test/**',async route=>{const name=new URL(route.request().url()).pathname.split('/').at(-1),args=route.request().postDataJSON();let result=[];
 if(name==='user')result=user;
 else if(name==='list_my_groups')result=[{id:'group',name:'医学科3年',role:'owner',icon:'group',accent:'blue',photo:savedPhoto,member_count:1,set_count:11}];
 else if(name==='quiz_profiles')result={display_name:'あなた'};
 else if(name==='quiz_group_learning_read')result={icon:'group',accent:'blue',folders:[],placements:[],members:[]};
 else if(name==='quiz_group_photo'){savedPhoto=args.p_photo;result=true;}
 else if(name==='quiz_group_learning_icon')result=true;
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 await mkdir('tmp/latest-mockup-screenshots',{recursive:true});
 await page.goto('http://127.0.0.1:5178/quiz/tests/browser/latest-mockup-preview.html');await page.getByRole('heading',{name:'脳神経',exact:true}).waitFor();
 assert.equal(await page.locator('.quiz-detail__filters summary').count(),0);
 assert.equal(await page.locator('.quiz-detail__summary svg').count(),0);assert.equal(await page.locator('.level-progress__legend small').count(),4);await page.getByRole('heading',{name:'進捗',exact:true}).waitFor();
 assert.deepEqual(await page.locator('.quiz-detail__metric strong').allTextContents(),['267','110','0%']);
 assert.equal(await page.locator('.quiz-detail__completion-row').evaluate(el=>Boolean(document.querySelector('.quiz-detail__body').compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)),true);
 for(const width of [320,390]){
   await page.setViewportSize({width,height:866});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.equal(await page.locator('.quiz-detail__segment-item').count(),0,'conditions stay off the main screen');
   assert.equal(await page.locator('.quiz-detail__entry-grid').evaluate(el=>el.getBoundingClientRect().top-document.querySelector('.quiz-detail__start-action--review').getBoundingClientRect().bottom>=24),true);
   assert.equal(await page.locator('.quiz-detail__summary').evaluate(el=>getComputedStyle(el).borderRadius),'10px');
   for(const button of await page.locator('.quiz-detail__start-action').all())assert.equal(await button.evaluate(el=>el.getBoundingClientRect().height),44);
   await page.screenshot({path:`tmp/latest-mockup-screenshots/detail-${width}.png`});
   await page.getByRole('button',{name:'出題条件を開く',exact:true}).click();
   const drawer=page.getByRole('dialog',{name:'出題条件',exact:true});await drawer.waitFor();
   await page.waitForFunction(()=>Math.abs(document.querySelector('.quiz-detail__condition-drawer').getBoundingClientRect().right-innerWidth)<1);
   assert.ok(await drawer.evaluate(el=>el.getBoundingClientRect().left>0));
   assert.equal(await page.locator('.quiz-detail__segment-item').first().evaluate(el=>el.getBoundingClientRect().height),36);
   assert.equal(await drawer.evaluate(el=>el.scrollWidth>el.clientWidth),false);
   await page.screenshot({path:`tmp/latest-mockup-screenshots/conditions-${width}.png`});
   await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
   assert.equal(await page.getByRole('button',{name:'出題条件を開く',exact:true}).evaluate(el=>document.activeElement===el),true);
 }
 await page.getByRole('button',{name:'出題条件を開く',exact:true}).click();await page.getByRole('button',{name:'Level 1',exact:true}).click();await page.getByRole('button',{name:'完了',exact:true}).click();
 await page.getByRole('button',{name:'出題条件を開く',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Level 1',exact:true}).getAttribute('aria-pressed'),'true');await page.mouse.click(5,400);await page.getByRole('dialog',{name:'出題条件',exact:true}).waitFor({state:'hidden'});await page.getByRole('button',{name:'登録順で解く',exact:true}).click();assert.equal(JSON.parse(await page.locator('body').getAttribute('data-session')).count,75);
 for(const [name,action] of [['資料','materials'],['問題一覧','questions'],['学習計画','plan'],['追加解説・メモ','notes']]){await page.getByRole('button',{name,exact:false}).click();assert.equal(await page.locator('body').getAttribute('data-action'),action);}
 await page.getByRole('button',{name:'学習済みにする',exact:true}).click();await page.getByRole('button',{name:'学習済みを解除',exact:true}).waitFor();
 await page.evaluate(async owner=>{
   const {publicationRepository,publicationScope}=await import('/quiz/src/utils/publicationStorage.ts');
   const identity={project:'https://latest-preview.example.test',userId:owner},scope=publicationScope(identity);
   await publicationRepository(identity).enqueue([
     {id:'public-fixture',title:'見つけるの公開検証',state:'completed',phase:'completed',applied:false,warning:'公開は完了しましたが、端末への反映・フォルダへの配置を確認できません。'},
     {id:'group-fixture',title:'このグループの共有検証',groupId:'group',state:'failed',error:'グループ共有の検証エラー',retryable:true},
     {id:'other-group-fixture',title:'別グループの共有検証',groupId:'other-group',state:'failed',error:'別グループの検証エラー',retryable:true},
   ].map(job=>({job:{scope,digest:'a'.repeat(64),localSetId:job.id,uploaded:4,total:4,createdAt:new Date().toISOString(),...job},payload:{p_set:{local_set_id:job.id,title:job.title},p_questions:[]}})));
 },owner);
 await page.goto('http://127.0.0.1:5178/quiz/tests/browser/latest-mockup-preview.html?view=groups');await page.getByRole('button',{name:'グループを作成',exact:false}).waitFor();await page.getByRole('button',{name:/医学科3年/}).waitFor();
 assert.equal(await page.locator('.publication-job').count(),0,'the group root never displays public or group publication history');
 for(const width of [320,390]){
   await page.setViewportSize({width,height:866});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   for(const card of await page.locator('.qm-group-action').all())assert.ok(await card.evaluate(el=>el.getBoundingClientRect().height>=44&&el.getBoundingClientRect().height<=112),'compact action remains a comfortable touch target');
   assert.equal(await page.locator('.qm-participating-groups').evaluate(el=>el.getBoundingClientRect().top<400),true,'joined groups stay near the top');
   await page.screenshot({path:`tmp/latest-mockup-screenshots/groups-${width}.png`});
 }
 await page.getByRole('button',{name:'グループを作成',exact:false}).click();await page.getByRole('textbox',{name:'新しいグループ',exact:true}).waitFor();assert.equal(await page.locator('.publication-job').count(),0);
 await page.getByRole('button',{name:'戻る',exact:true}).click();await page.getByRole('button',{name:'コードで参加',exact:false}).click();await page.getByRole('textbox',{name:'招待コードで参加',exact:true}).waitFor();assert.equal(await page.locator('.publication-job').count(),0);
 await page.getByRole('button',{name:'戻る',exact:true}).click();await page.getByRole('button',{name:/医学科3年/}).click();
 await page.getByText('このグループの共有検証',{exact:true}).waitFor();assert.equal(await page.locator('.publication-job').count(),1);
 assert.equal(await page.getByText('見つけるの公開検証',{exact:true}).count(),0);assert.equal(await page.getByText('別グループの共有検証',{exact:true}).count(),0);
 const stored=await page.evaluate(async owner=>{const {publicationRepository}=await import('/quiz/src/utils/publicationStorage.ts');return publicationRepository({project:'https://latest-preview.example.test',userId:owner}).list();},owner);
 assert.equal(stored.length,3);assert.equal(stored.find(job=>job.id==='public-fixture').applied,false,'hidden public jobs remain available for retry in their own screen');
 await page.getByRole('button',{name:'グループの管理',exact:true}).click();await page.getByLabel('写真を選ぶ',{exact:false}).setInputFiles({name:'photo.jpg',mimeType:'image/jpeg',buffer:Buffer.from(photo.split(',')[1],'base64')});await page.getByRole('button',{name:'アイコンを保存',exact:true}).click();assert.ok(savedPhoto.startsWith('data:image/jpeg;base64,'));
 assert.deepEqual(errors,[]);console.log('Latest mockup browser: 320/390px compact actions, publication scope/retention, create/join navigation, real study counts and photo upload passed');
}finally{await browser?.close();server.kill();}
