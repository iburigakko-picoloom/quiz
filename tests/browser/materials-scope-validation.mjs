import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {mkdir} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5179','--strictPort'],{env:{...process.env,VITE_SUPABASE_URL:'https://materials-scope.example.test',VITE_SUPABASE_ANON_KEY:'fixture'},stdio:['ignore','pipe','pipe'],windowsHide:true});let browser,inspection;
try{
 await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Server timeout')),20000);server.stdout.on('data',raw=>{if(raw.toString().includes('5179')){clearTimeout(timer);done();}});server.once('exit',code=>{clearTimeout(timer);fail(Error('Server exit '+code));});});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1024,height:900}}),errors=[];inspection=page;page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 await page.goto('http://127.0.0.1:5179/quiz/tests/browser/materials-scope-preview.html');await page.getByText('脳神経.pdf',{exact:true}).waitFor();
 await page.locator('.category-note-canvas-area').waitFor();
 const before=await page.evaluate(()=>window.materialsFixture.read());
 await page.getByLabel('資料の操作',{exact:true}).click();await page.getByRole('button',{name:'参照ページを調整',exact:true}).click();
 await page.getByRole('dialog').getByText('脳神経.pdf',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').locator('select').count(),0);assert.equal(await page.getByText('循環器資料.pdf',{exact:true}).count(),0);assert.equal(await page.getByText('別セットの無関係なPDF.pdf',{exact:true}).count(),0);
 await page.getByRole('button',{name:'1問を登録',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'既存の参照先を開く',exact:true}).click();await page.getByText('循環器資料.pdf',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('資料を切り替え',{exact:true}).count(),0,'following one reference does not expose the other set PDF picker');assert.equal(await page.getByText('別セットの無関係なPDF.pdf',{exact:true}).count(),0);
 await page.getByLabel('資料の操作',{exact:true}).click();await page.getByRole('button',{name:'この問題セットの資料に戻る',exact:true}).click();await page.getByText('脳神経.pdf',{exact:true}).waitFor();
 // Request the already-linked page again through the drawer so that adding a
 // PDF below is tested while the other set's reference is actually displayed.
 await page.getByRole('button',{name:'既存の参照先を開く',exact:true}).click();await page.getByText('循環器資料.pdf',{exact:true}).waitFor();
 const bytes=await page.evaluate(()=>window.materialsFixture.pdfBytes);
 await page.locator('.materials-content[aria-busy="false"]').waitFor();await page.getByLabel('資料の操作',{exact:true}).click();
 const picker=page.waitForEvent('filechooser');await page.getByRole('button',{name:'PDFを追加',exact:true}).click();await(await picker).setFiles({name:'新しく追加.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)});
 await page.getByLabel('資料を切り替え',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.materials-picker')?.selectedOptions[0]?.textContent==='新しく追加.pdf');
 const after=await page.evaluate(()=>window.materialsFixture.read());assert.equal(after.local.materials.length,2);assert.equal(after.local.materials[1].title,'新しく追加.pdf');assert.deepEqual(after.other,before.other);assert.equal(after.ink,before.ink);
 const refs=await page.evaluate(async()=>{const {loadAppDataAsync}=await import('/quiz/src/storage.ts');return (await loadAppDataAsync()).questions.map(q=>q.materialReferences);});assert.deepEqual(refs,[[{materialId:'attached',pageId:'attached-page'}],[{materialId:'linked',pageId:'linked-page'}]]);
 await mkdir('tmp/materials-scope-screenshots',{recursive:true});for(const width of [320,390]){await page.setViewportSize({width,height:866});assert.equal(await page.locator('.materials-panel').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.screenshot({path:`tmp/materials-scope-screenshots/local-${width}.png`});}
 const empty=await browser.newPage({viewport:{width:390,height:866}});empty.on('pageerror',e=>errors.push(e.message));await empty.goto('http://127.0.0.1:5179/quiz/tests/browser/materials-scope-preview.html?empty=1');await empty.getByRole('button',{name:'PDFを追加',exact:true}).waitFor();await empty.getByLabel('資料の操作',{exact:true}).click();await empty.getByRole('button',{name:'参照ページを調整',exact:true}).click();await empty.getByRole('dialog').getByText('この問題セットにPDFを追加してから設定できます。',{exact:true}).waitFor();assert.equal(await empty.getByRole('dialog').locator('select').count(),0);assert.deepEqual(errors,[]);
 console.log('Materials scope: attached-only PDF choices, preserved cross-set jumps, local addition while reading a foreign PDF, unchanged original/ink/references, empty state and 320/390px passed');
}catch(error){if(inspection){console.log(await inspection.locator('.materials-panel').innerText());console.log(await inspection.locator('.materials-content').evaluate(el=>({busy:el.getAttribute('aria-busy'),class:el.className,canvasCount:el.querySelectorAll('canvas').length})));await inspection.screenshot({path:'tmp/materials-scope-failure.png'});}throw error;}finally{await browser?.close();server.kill();}
