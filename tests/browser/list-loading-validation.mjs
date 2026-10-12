import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5178','--strictPort'],{cwd:resolve('.'),env:{...process.env,VITE_SUPABASE_URL:'https://list-preview.example.test',VITE_SUPABASE_ANON_KEY:'test-public-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,page;
const errors=[],pending={public:[],groups:[],mine:[]},hold={public:true,groups:true,mine:true};
const release=kind=>{hold[kind]=false;pending[kind].splice(0).forEach(done=>done());};
const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',time='2026-10-12T00:00:00Z';
const user=id=>({id,aud:'authenticated',role:'authenticated',email:'fixture@example.test',user_metadata:{},app_metadata:{},created_at:time});
const token=id=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.test`;
let publicTitle='すぐ表示する公開フォルダ',failPublic=false;
try{
  await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Server timeout')),15000);server.stdout.on('data',chunk=>{if(chunk.toString().includes('5178')){clearTimeout(timer);done();}});server.once('exit',code=>{clearTimeout(timer);fail(Error('Server exit '+code));});});
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({user,token})=>localStorage.setItem('sb-list-preview-auth-token',JSON.stringify({user,access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600})),{user:user(owner),token:token(owner)});
  await page.route('https://list-preview.example.test/**',async route=>{
    const req=route.request(),name=new URL(req.url()).pathname.split('/').at(-1),auth=req.headers().authorization??'';
    let actor=owner;try{actor=JSON.parse(Buffer.from(auth.split('.')[1],'base64url').toString()).sub;}catch{}
    const kind=name==='quiz_public_search'?'public':name==='list_my_groups'?'groups':name==='shared_problem_sets'?'mine':null;
    if(kind&&hold[kind])await new Promise(done=>pending[kind].push(done));
    let result=[];
    if(name==='user')result=user(actor);
    else if(name==='logout')result={};
    else if(name==='quiz_public_search'){
      if(failPublic){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'temporary failure'})});return;}
      result={folders:[{id:'folder',owner_id:owner,name:publicTitle,author_name:'教材チーム',description:'',category:'医学',tags:[],published:true,set_count:1,question_count:10,import_count:3,updated_at:time}],sets:[],categories:['医学']};
    }else if(name==='list_my_groups')result=[{id:'group-'+actor,name:actor===owner?'すぐ表示するグループ':'別アカウントのグループ',role:'owner',member_count:2,set_count:1}];
    else if(name!=='shared_problem_sets'){errors.push('Unexpected request '+name);}
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto('http://127.0.0.1:5178/quiz/tests/browser/list-loading-preview.html');
  const nav=label=>page.getByRole('button',{name:label,exact:true});
  await nav('見つける').click();await page.getByRole('status',{name:'公開フォルダを読み込み中'}).waitFor();
  assert.equal(await page.getByText('条件に合うフォルダはありません。',{exact:true}).count(),0);
  await mkdir('tmp/list-loading',{recursive:true});await page.screenshot({path:'tmp/list-loading/public-cold.png'});
  release('public');await page.getByRole('button',{name:/すぐ表示する公開フォルダ/}).waitFor();
  await nav('ホーム').click();hold.public=true;failPublic=true;await nav('見つける').click();
  await page.getByRole('button',{name:/すぐ表示する公開フォルダ/}).waitFor();assert.equal(hold.public,true,'Preview appears while network is blocked');
  await page.screenshot({path:'tmp/list-loading/public-warm.png'});release('public');await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:/すぐ表示する公開フォルダ/}).count(),1);
  failPublic=false;publicTitle='最新の公開フォルダ';await page.getByRole('button',{name:'再読み込み',exact:true}).click();await page.getByRole('button',{name:/最新の公開フォルダ/}).waitFor();
  await nav('グループ').click();await page.getByRole('status',{name:'参加中のグループを読み込み中'}).waitFor();
  assert.equal(await page.getByText('グループ機能はログイン後に使えます',{exact:true}).count(),0);await page.screenshot({path:'tmp/list-loading/groups-cold.png'});
  release('groups');await page.getByRole('button',{name:/すぐ表示するグループ/}).waitFor();assert.equal(hold.mine,true,'Unrelated publication request does not block groups');
  await nav('ホーム').click();hold.groups=true;await nav('グループ').click();await page.getByRole('button',{name:/すぐ表示するグループ/}).waitFor();
  assert.equal(hold.groups,true,'Cached groups appear before response');await page.screenshot({path:'tmp/list-loading/groups-warm.png'});
  await page.evaluate(async()=>{const {cloudClient}=await import('/quiz/src/utils/cloudService.ts');await cloudClient.auth.signOut({scope:'local'});});
  await page.getByText('グループ機能はログイン後に使えます',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/すぐ表示するグループ/}).count(),0);
  await page.evaluate(async access_token=>{const {cloudClient}=await import('/quiz/src/utils/cloudService.ts');await cloudClient.auth.setSession({access_token,refresh_token:'other-refresh'});},token(other));
  await page.getByRole('status',{name:'参加中のグループを読み込み中'}).waitFor();assert.equal(await page.getByRole('button',{name:/すぐ表示するグループ/}).count(),0);
  release('groups');release('mine');await page.getByRole('button',{name:/別アカウントのグループ/}).waitFor();assert.equal(await page.getByRole('button',{name:/すぐ表示するグループ/}).count(),0);
  assert.deepEqual(errors,[]);console.log('Cold skeletons, warm previews, background refresh, failure retention, independent group requests and account isolation passed.');
}catch(error){if(page)console.error(await page.locator('body').innerText());throw error;}
finally{release('public');release('groups');release('mine');await browser?.close();server.kill();}
