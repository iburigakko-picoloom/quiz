import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.QUIZMAKE_PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href:'playwright');
const stage=process.env.QUIZMAKE_LAYOUT_STAGE??'after';
const output=resolve(`qa/discovery-layout/${stage}`);await mkdir(output,{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5177','--strictPort'],{cwd:resolve('.'),env:{...process.env,VITE_SUPABASE_URL:'https://public-preview.example.test',VITE_SUPABASE_ANON_KEY:'public-test-key'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser;const errors=[],results=[];
try{
  await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Preview server timeout')),15000);server.stdout.on('data',bytes=>{if(bytes.toString().includes('5177')){clearTimeout(timer);done();}});server.once('exit',code=>{clearTimeout(timer);fail(Error('Preview server exit '+code));});});
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({serviceWorkers:'block',isMobile:true,hasTouch:true});
  const actor='00000000-0000-4000-8000-000000000001',time='2026-10-09T00:00:00Z';
  const user={id:actor,aud:'authenticated',role:'authenticated',email:'fixture@example.test',user_metadata:{},app_metadata:{},created_at:time};
  const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:actor,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`;
  await context.addInitScript(({user,token})=>localStorage.setItem('sb-public-preview-auth-token',JSON.stringify({user,access_token:token,refresh_token:'fixture',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600})),{user,token});
  const sets=Array.from({length:31},(_,i)=>({id:`set-${i}`,owner_id:actor,local_set_id:`local-${i}`,title:`問題セット ${i+1} — 復習問題`,author_name:'試験用',description:'説明は詳細画面で確認する教材。',subject:'医学',audience:'CBT',source:'',visibility:'public',standalone_public:true,question_count:15,import_count:23,updated_at:time,published_at:time,version_id:`version-${i}`,tags:['循環器','CBT'],questions:[]}));
  const folders=Array.from({length:31},(_,i)=>({id:`folder-${i}`,owner_id:actor,name:`公開フォルダ ${i+1}`,author_name:'試験用',description:'長い説明は詳細で表示。',category:'医学',tags:['CBT','循環器'],published:true,set_count:1,question_count:15,import_count:23,updated_at:time,members:[{...sets[i],member_path:[]}]}));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.hostname==='127.0.0.1'){await route.continue();return;}
    assert.equal(url.hostname,'public-preview.example.test','No production/external connections');
    const name=url.pathname.split('/').at(-1),args=request.postDataJSON()??{};let result;
    if(name==='user')result=user;
    else if(name==='quiz_public_search')result={folders:args.p_kind==='set'?[]:folders.slice(args.p_offset??0,(args.p_offset??0)+31),sets:args.p_kind==='folder'?[]:sets.slice(args.p_offset??0,(args.p_offset??0)+31),categories:['医学']};
    else if(name==='quiz_public_mine')result={folders,sets};
    else if(name==='quiz_public_folder')result=folders.find(f=>f.id===args.p_id);
    else if(name==='get_shared_problem_set_versioned')result=sets.find(s=>s.id===args.p_set_id);
    else if(name==='quiz_profiles')result={display_name:'試験用'};
    else throw Error('Unexpected RPC '+name);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const sizes=[[320,568],[390,844],[430,932],[568,320],[844,390],[390,390]];
  for(const [width,height]of sizes){
    await page.setViewportSize({width,height});await page.goto('http://127.0.0.1:5177/quiz/tests/browser/public-discovery-preview.html');
    await page.locator('.public-library-row__open').first().waitFor();await page.locator('.public-loading').waitFor({state:'hidden'});
    await page.evaluate(()=>{for(const el of [document.documentElement,document.body,document.getElementById('root')]){el.style.setProperty('--safe-top','20px');el.style.setProperty('--safe-bottom','34px');}});
    const top=await page.evaluate(()=>{const nav=document.querySelector('.primary-bottom-nav').getBoundingClientRect();const rows=[...document.querySelectorAll('.public-library-row__open')].map(el=>el.getBoundingClientRect());return {rowHeight:rows[0].height,fullyVisibleRows:rows.filter(r=>r.top>=0&&r.bottom<=nav.top).length,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};});
    await page.screenshot({path:resolve(output,`top-${width}x${height}.png`)});
    for(const kind of ['フォルダ','問題セット']){
      await page.getByRole('tab',{name:kind,exact:true}).click();await page.locator('.public-loading').waitFor({state:'hidden'});
      const more=page.getByRole('button',{name:'もっと見る',exact:true});await more.waitFor();
      await page.locator('.app-layout__scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      const tail=await more.evaluate(el=>{const box=el.getBoundingClientRect(),nav=document.querySelector('.primary-bottom-nav').getBoundingClientRect();return {buttonTop:box.top,buttonBottom:box.bottom,navTop:nav.top,usable:box.top>=0&&box.bottom<=nav.top};});
      await page.screenshot({path:resolve(output,`tail-${kind==='フォルダ'?'folders':'sets'}-${width}x${height}.png`)});
      results.push({width,height,kind,...top,...tail});
      if(stage==='after'){
        assert.equal(top.horizontalOverflow,false);assert.ok(top.rowHeight>=44&&top.rowHeight<=82,`Compact readable row: ${width}x${height} ${top.rowHeight}`);
        assert.equal(tail.usable,true,`Last button must be above nav: ${JSON.stringify(tail)}`);
        await more.click();await page.locator('.public-loading').waitFor({state:'hidden'});assert.equal(await page.locator('.public-library-row').count(),31);
        await page.locator('.app-layout__scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});const last=page.locator('.public-library-row__open').last();
        assert.equal(await last.evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.primary-bottom-nav').getBoundingClientRect().top),true);
        await last.click();await page.getByRole('button',{name:kind==='フォルダ'?'このフォルダを取り込む':'この問題セットを取り込む',exact:true}).waitFor();
        await page.getByRole('button',{name:'戻る',exact:true}).click();await page.locator('.public-library-row').first().waitFor();
      }
    }
    await page.getByRole('button',{name:'検索条件',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
    await dialog.getByRole('button',{name:'この条件で検索',exact:true}).scrollIntoViewIfNeeded();
    if(stage==='after')assert.equal(await dialog.getByRole('button',{name:'この条件で検索',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
    await page.screenshot({path:resolve(output,`filters-${width}x${height}.png`)});
  }
  assert.deepEqual(errors,[]);await writeFile(resolve(output,'metrics.json'),JSON.stringify({stage,results,errors,isolatedFixture:true,realDevice:false},null,2));console.log(JSON.stringify({stage,cases:results.length,unusableTailButtons:results.filter(r=>!r.usable).length,results}));
}finally{await browser?.close();server.kill();}
