import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';process.env.VITE_SUPABASE_ANON_KEY='fixture';
const playwright=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const engine=process.env.QUIZMAKE_TEST_BROWSER||'webkit';
const server=await createServer({server:{host:'127.0.0.1',port:5199,strictPort:true,watch:{ignored:['**/tmp/**']}}});await server.listen();
const browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
try {
  const page=await browser.newPage({viewport:{width:1024,height:900},hasTouch:true,isMobile:engine==='webkit'}),errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:5199/quiz/tests/browser/materials-scope-preview.html?library');
  const ready=()=>page.locator('.category-note-canvas[aria-disabled="false"]').waitFor();await ready();
  await page.getByRole('button',{name:'参照ページを追加',exact:true}).tap();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert.equal(await dialog.getByLabel('追加するページ',{exact:true}).inputValue(),'attached-page');
  await dialog.getByRole('checkbox').nth(0).check();await dialog.getByRole('checkbox').nth(1).check();
  await dialog.getByRole('button',{name:'2問を登録',exact:true}).tap();await dialog.waitFor({state:'hidden'});
  const refs=()=>page.evaluate(async()=>{const {loadAppDataAsync}=await import('/quiz/src/storage.ts');return (await loadAppDataAsync()).questions.map(q=>q.materialReferences);});
  assert.deepEqual(await refs(),[[{materialId:'attached',pageId:'attached-page'}],[{materialId:'linked',pageId:'linked-page'},{materialId:'attached',pageId:'attached-page'}]]);
  await page.getByRole('button',{name:'参照ページを追加',exact:true}).tap();await dialog.waitFor();
  await dialog.getByRole('checkbox').nth(1).waitFor();
  for(const row of await dialog.getByRole('checkbox').all())assert.equal(await row.isDisabled(),true);
  await dialog.getByRole('button',{name:'閉じる',exact:true}).tap();
  await mkdir('tmp/note-reference-validation',{recursive:true});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:900});await ready();
    assert.equal(await page.locator('.materials-controls').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
    await page.getByRole('button',{name:'参照ページを追加',exact:true}).tap();await dialog.waitFor();
    await dialog.getByRole('checkbox').nth(1).waitFor();
    assert.equal(await dialog.evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
    await page.screenshot({path:`tmp/note-reference-validation/${engine}-${width}.png`});
    await dialog.getByRole('button',{name:'閉じる',exact:true}).tap();
  }
  await page.setViewportSize({width:1024,height:900});
  await page.getByRole('button',{name:'メモ',exact:true}).tap();await ready();
  const canvas=page.locator('.category-note-canvas'),box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width*.3,box.y+box.height*.4);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:8});await page.mouse.up();
  await page.evaluate(async()=>{const {waitForPendingCategoryNoteSaves}=await import('/quiz/src/utils/noteStorage.ts');await new Promise(r=>setTimeout(r,30));await waitForPendingCategoryNoteSaves();});
  const pixels=()=>canvas.evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});
  const originalInk=await pixels();assert.ok(originalInk>100);
  // Keep persistence busy: a page turn should still finish, then flush durably on exit.
  await page.evaluate(async()=>{
    const {withCoordinatedDataMutation}=await import('/quiz/src/utils/dataCoordination.ts');
    await new Promise(started=>{void withCoordinatedDataMutation(['notes'],()=>new Promise(resolve=>{window.releaseNoteLock=resolve;started();}));});
    window.pngSnapshots=0;const original=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(...args){window.pngSnapshots++;return original.apply(this,args);};
  });
  const started=Date.now();await page.getByRole('button',{name:'次のページ',exact:true}).tap();
  await page.waitForFunction(()=>document.querySelector('[aria-label="ページ"]').value==='1'&&document.querySelector('.category-note-canvas[aria-disabled="false"]'));
  const navigationMs=Date.now()-started;assert.ok(navigationMs<2000,`page turn waited for persistence: ${navigationMs}ms`);
  assert.equal(await pixels(),0);assert.equal(await page.evaluate(()=>window.pngSnapshots),0,'unchanged pages are not re-encoded');
  await page.getByRole('button',{name:'前のページ',exact:true}).tap();
  await page.waitForFunction(()=>document.querySelector('[aria-label="ページ"]').value==='0'&&document.querySelector('.category-note-canvas[aria-disabled="false"]'));
  assert.equal(await pixels(),originalInk);
  await page.evaluate(()=>window.releaseNoteLock());
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByLabel('ページ',{exact:true}).selectOption('2');await ready();assert.equal(await pixels(),0);
  await page.getByLabel('ページ',{exact:true}).selectOption('0');await ready();assert.equal(await pixels(),originalInk);
  await page.getByRole('button',{name:'メモ',exact:true}).tap();await ready();
  await page.getByRole('button',{name:'メモ',exact:true}).tap();await ready();assert.equal(await pixels(),originalInk);
  await page.emulateMedia({reducedMotion:'no-preference'});
  // End a stroke and turn in the same task, before the deferred autosave runs.
  await canvas.evaluate(c=>{
    // Synthetic pen events have no browser-owned pointer to capture.
    const capture=c.setPointerCapture,release=c.releasePointerCapture;c.setPointerCapture=()=>{};c.releasePointerCapture=()=>{};
    const r=c.getBoundingClientRect(),send=(type,x,y)=>c.dispatchEvent(new PointerEvent(type,{pointerId:50,pointerType:'pen',isPrimary:true,buttons:type==='pointerup'?0:1,button:0,clientX:r.x+r.width*x,clientY:r.y+r.height*y,bubbles:true}));
    send('pointerdown',.2,.7);send('pointermove',.65,.8);send('pointerup',.65,.8);
    c.setPointerCapture=capture;c.releasePointerCapture=release;
    const rail=document.querySelector('.category-note-page-rail');
    rail.addEventListener('transitionend',e=>e.stopImmediatePropagation(),{capture:true});
    const next=document.querySelector('button[aria-label="次のページ"]');next.click();next.click();
    rail.style.transition='none';
  });
  await page.waitForFunction(()=>document.querySelector('[aria-label="ページ"]').value==='1'&&document.querySelector('.category-note-canvas[aria-disabled="false"]'));
  assert.equal(await pixels(),0,'the deferred save must not move ink into the next page');
  await page.getByRole('button',{name:'前のページ',exact:true}).tap();
  await page.waitForFunction(()=>document.querySelector('[aria-label="ページ"]').value==='0'&&document.querySelector('.category-note-canvas[aria-disabled="false"]'));
  const latestInk=await pixels();assert.ok(latestInk>originalInk,'the stroke immediately before navigation is retained');
  await page.evaluate(()=>{document.querySelector('button[aria-label="次のページ"]').click();document.querySelector('.materials-memo-button').click();});
  await page.locator('.materials-memo-button[aria-pressed="false"]').waitFor();await ready();
  await page.getByRole('button',{name:'メモ',exact:true}).tap();await ready();assert.equal(await pixels(),0);
  await page.getByLabel('ページ',{exact:true}).selectOption('0');
  await page.waitForFunction(()=>document.querySelector('[aria-label="ページ"]').value==='0'&&document.querySelector('.category-note-canvas[aria-disabled="false"]'));
  assert.equal(await pixels(),latestInk,'leaving during the animation releases and flushes the pending save');
  assert.deepEqual(errors,[]);
  console.log(`PASS (${engine}): library registration without source pages, append/dedup, 320/390 layouts, navigation during blocked persistence (${navigationMs}ms), zero PNG re-encodes, ink survives navigation/exit, reduced motion, immediate ink/page turn, duplicate clicks, missing transition event`);
}finally{await browser.close();await server.close();}
