import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5186','--strictPort'],{env:{...process.env,VITE_SUPABASE_URL:'https://profile-preview.example.test',VITE_SUPABASE_ANON_KEY:'test-key'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser;
try{
 await new Promise((ok,no)=>{server.stdout.on('data',s=>{if(s.toString().includes('5186'))ok()});server.once('exit',code=>no(new Error(`server exited ${code}`)))});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const user={id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'person@example.test',app_metadata:{},user_metadata:{},created_at:new Date().toISOString(),identities:[{provider:'custom:line',identity_data:{name:'LINEの名前',picture:'https://avatar.example.test/photo.png'}}]};
 const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.test`;
 await page.addInitScript(({user,token})=>localStorage.setItem('sb-profile-preview-auth-token',JSON.stringify({access_token:token,refresh_token:'test',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{user,token});
 let storedName='設定した名前';let saves=0;
 await page.route('https://avatar.example.test/**',r=>r.fulfill({status:404}));
 await page.route('https://profile-preview.example.test/**',async route=>{
  const url=new URL(route.request().url());let result;
  if(url.pathname==='/auth/v1/user')result=user;
  else if(url.pathname.endsWith('/quiz_profiles'))result={display_name:storedName};
  else if(url.pathname.endsWith('/set_profile_display_name')){storedName=route.request().postDataJSON().p_display_name;saves++;result=null;}
  else throw new Error(`unexpected ${url.pathname}`);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto('http://127.0.0.1:5186/quiz/tests/browser/account-profile-preview.html',{waitUntil:'domcontentloaded'});
 await page.getByLabel('共有時の表示名').fill('設定した名前');
 await page.getByRole('button',{name:'LINEの名前を使う',exact:true}).waitFor();
 assert.equal(saves,0);
 await page.getByRole('button',{name:'同期画面',exact:true}).click();
 await page.locator('.sync-account-summary').getByText('設定した名前',{exact:true}).waitFor();
 await page.locator('.sync-account-avatar svg').waitFor();
 await page.evaluate(async()=>{(await import('/quiz/src/utils/accountSync.ts')).publishAccountSyncState({phase:'ready',syncId:'a'.repeat(36)});});
 await page.getByRole('button',{name:'更新を確認',exact:true}).waitFor();await page.getByRole('button',{name:'詳細設定',exact:true}).waitFor();await page.getByRole('button',{name:'バックアップ・復旧',exact:true}).waitFor();
 for(const width of [320,360,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}await page.setViewportSize({width:390,height:844});
 await mkdir('qa/phase6',{recursive:true});await page.screenshot({path:'qa/phase6/account-sync-390.png'});
 await page.getByRole('button',{name:'設定画面',exact:true}).click();
 await page.getByRole('button',{name:'LINEの名前を使う',exact:true}).click();
 assert.equal(await page.getByLabel('共有時の表示名').inputValue(),'LINEの名前');assert.equal(saves,0,'adoption only fills the editable draft');
 await page.getByRole('button',{name:'表示名を保存',exact:true}).click();await page.getByText('表示名を更新しました。',{exact:true}).waitFor();assert.equal(saves,1);
 await page.getByRole('button',{name:'同期画面',exact:true}).click();await page.locator('.sync-account-summary').getByText('LINEの名前',{exact:true}).waitFor();
 assert.equal(await page.evaluate(async()=>{const {getCloudAccountProfile}=await import('/quiz/src/utils/cloudService.ts');try{await getCloudAccountProfile('different-user');return false;}catch{return true;}}),true);
 storedName='';user.identities=[];
 await page.getByRole('button',{name:'設定画面',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.settings-account__field input')?.value==='person');
 assert.equal(await page.getByRole('button',{name:'LINEの名前を使う',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 console.log('PASS account profile: saved-name priority, explicit LINE adoption, settings/sync consistency, failed-avatar fallback, 390px.');
}finally{await browser?.close();server.kill();}
