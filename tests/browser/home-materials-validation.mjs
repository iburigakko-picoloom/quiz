import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
const {chromium}=await import(pathToFileURL('C:/Users/manat/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5201','--strictPort'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser;
try {
 await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('server timeout')),30000);server.stdout.on('data',s=>{if(s.toString().includes('5201')){clearTimeout(timer);ok()}});server.once('exit',fail)});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',route=>route.abort());
 const url='http://127.0.0.1:5201/quiz/tests/browser/companion-care-preview.html?answers=0';await page.goto(url,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'学習計画'}).waitFor();
 const pdfdoc=await PDFDocument.create();pdfdoc.addPage([200,280]);const pdf='data:application/pdf;base64,'+Buffer.from(await pdfdoc.save()).toString('base64');
 await page.evaluate(async(pdf)=>{
  const {loadAppDataAsync,saveAppData}=await import('/quiz/src/storage.ts');const {saveCategoryNoteRaw}=await import('/quiz/src/utils/noteStorage.ts');const {materialIndexKey,materialFileKey}=await import('/quiz/src/utils/materialStorage.ts');
  const data=await loadAppDataAsync();const stamp=new Date().toISOString();data.problemSets.push({id:'other',folderId:'f',title:'循環器の教材',source:'',createdAt:stamp,updatedAt:stamp});if(!await saveAppData(data))throw Error('save failed');
  for(const [setId,items] of [['s',[['a','神経資料']]],['other',Array.from({length:20},(_,i)=>['b'+i,`心臓資料${i}`])]]){await saveCategoryNoteRaw(materialIndexKey(setId),JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:setId,updatedAt:stamp,materials:items.map(([id,title])=>({id,title,pages:[{id:id+'-page',kind:'pdf',pdfPage:1}]}))}));for(const [id] of items)await saveCategoryNoteRaw(materialFileKey(setId,id),JSON.stringify({kind:'quiz-material-file',version:1,materialId:id,dataUrl:pdf,updatedAt:stamp}));}
 },pdf);
 await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'資料',exact:true}).click();await page.getByRole('button',{name:/心臓資料19/}).waitFor();assert.equal(await page.getByRole('button',{name:/神経資料/}).count(),1);
 await page.getByRole('searchbox',{name:'資料を検索'}).fill('循環器');assert.equal(await page.getByRole('button',{name:/神経資料/}).count(),0);const target=page.getByRole('button',{name:/心臓資料19/});await target.scrollIntoViewIfNeeded();const beforeScroll=await page.locator('.quiz-home__materials').evaluate(node=>node.scrollTop);assert.ok(beforeScroll>0);await target.click();await page.getByRole('heading',{name:'循環器の教材'}).waitFor();await page.waitForFunction(()=>document.querySelector('select.materials-picker')?.value==='b19');
 await page.goBack();await page.getByRole('button',{name:/心臓資料19/}).waitFor();assert.equal(await page.getByRole('searchbox',{name:'資料を検索'}).inputValue(),'循環器');assert.ok(Math.abs(await page.locator('.quiz-home__materials').evaluate(node=>node.scrollTop)-beforeScroll)<4);await mkdir('qa/home-materials',{recursive:true});await page.screenshot({path:'qa/home-materials/390.png'});for(const width of [320,360,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 await page.evaluate(()=>localStorage.setItem('quizMakeDeviceRole:v1','sub'));await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'資料',exact:true}).click();await page.getByText('資料を開くにはメイン端末に切り替えてください。').waitFor();assert.equal(await page.getByRole('button',{name:/心臓資料19/}).isDisabled(),true);
 assert.deepEqual(errors,[]);console.log('PASS: cross-set list, title search, correct owner/material, browser back and query, viewport widths.');
}finally{await browser?.close();server.kill();}
