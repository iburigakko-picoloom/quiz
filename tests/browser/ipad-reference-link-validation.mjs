import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY='fixture';
const playwright=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const engine=process.env.QUIZMAKE_TEST_BROWSER||'webkit';
const server=await createServer({server:{host:'127.0.0.1',port:5198,strictPort:true,watch:{ignored:['**/tmp/**']}}});
await server.listen();
const browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
try {
  const page=await browser.newPage({viewport:{width:1024,height:768},hasTouch:true,isMobile:engine==='webkit',deviceScaleFactor:2});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.route('https://**/*',r=>r.abort());
  await page.goto('http://127.0.0.1:5198/quiz/tests/browser/materials-scope-preview.html',{timeout:60000});
  await page.locator('.category-note-canvas[aria-disabled="false"]').waitFor();
  const menu=page.locator('.materials-menu');
  assert.equal(await page.getByRole('button',{name:'参照ページを追加',exact:true}).isVisible(),false,'add reference is hidden while the menu is closed');
  assert.equal(await page.locator('.materials-reference-actions').count(),0,'no extra reference row above the paper');
  await page.getByLabel('資料の操作',{exact:true}).tap();
  await menu.getByRole('button',{name:'参照ページを追加',exact:true}).tap();
  await page.getByRole('dialog').waitFor();
  assert.equal(await menu.getAttribute('open'),null);
  assert.equal(await page.getByLabel('追加するページ',{exact:true}).inputValue(),'attached-page','the menu action keeps the current page selected');
  await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).tap();
  await page.getByLabel('資料の操作',{exact:true}).tap();
  await page.getByRole('button',{name:'参照ページを調整',exact:true}).tap();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'1問を登録',exact:true}).tap();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  const refs=()=>page.evaluate(async()=>{
    const {loadAppDataAsync}=await import('/quiz/src/storage.ts');
    return (await loadAppDataAsync()).questions.find(q=>q.id==='q1').materialReferences;
  });
  assert.deepEqual(await refs(),[{materialId:'attached',pageId:'attached-page'}]);
  await page.getByLabel('資料の操作',{exact:true}).tap();
  await page.getByRole('button',{name:'このページの紐付けを解除',exact:true}).tap();
  await page.waitForFunction(async()=>{const {loadAppDataAsync}=await import('/quiz/src/storage.ts');return !(await loadAppDataAsync()).questions.find(q=>q.id==='q1').materialReferences?.length;});
  await page.getByLabel('資料の操作',{exact:true}).tap();
  // iPad users can arrive with focus still on the menu summary (keyboard,
  // accessibility, or a prior interaction). Safari buttons need not take focus.
  await page.getByLabel('資料の操作',{exact:true}).focus();
  await page.getByRole('button',{name:'このページを問題に紐付け',exact:true}).tap();
  await page.waitForFunction(async()=>{const {loadAppDataAsync}=await import('/quiz/src/storage.ts');return (await loadAppDataAsync()).questions.find(q=>q.id==='q1').materialReferences?.length===1;});
  assert.equal(await menu.getAttribute('open'),null);
  assert.deepEqual(await refs(),[{materialId:'attached',pageId:'attached-page'}]);
  const summary=page.getByLabel('資料の操作',{exact:true});
  await summary.tap();
  await summary.focus();
  await page.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('open'),null,'Escape dismisses the menu');
  assert.equal(await summary.evaluate(el=>document.activeElement===el),true);
  await summary.tap();
  await summary.focus();
  if(engine==='webkit'){
    // Mobile WebKit automation does not move focus with Tab. Exercise the
    // null-relatedTarget blur produced when keyboard focus leaves the window.
    await summary.dispatchEvent('keydown',{key:'Tab',bubbles:true});
    await summary.evaluate(el=>el.blur());
  } else await page.keyboard.press('Shift+Tab');
  assert.equal(await menu.getAttribute('open'),null,'Tab out dismisses the menu');
  await summary.tap();
  await summary.focus();
  const unlink=page.getByRole('button',{name:'このページの紐付けを解除',exact:true});
  await unlink.dispatchEvent('pointerdown',{pointerId:1,pointerType:'touch',bubbles:true});
  await summary.evaluate(el=>el.blur());
  await unlink.dispatchEvent('pointercancel',{pointerId:1,pointerType:'touch',bubbles:true});
  assert.deepEqual(await refs(),[{materialId:'attached',pageId:'attached-page'}],'a cancelled touch does not execute the action');
  await page.locator('.materials-title').tap();
  assert.equal(await menu.getAttribute('open'),null,'outside taps dismiss the menu');
  await summary.tap();
  const picker=page.locator('.materials-menu input[type=file][accept="application/pdf,.pdf"]');
  const chooserEvent=page.waitForEvent('filechooser');await picker.tap();
  const chooser=await chooserEvent;
  const bytes=await page.evaluate(()=>window.materialsFixture.pdfBytes);
  await chooser.setFiles({name:'iPad追加.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)});
  await page.waitForFunction(async()=>{const {loadMaterials}=await import('/quiz/src/utils/materialStorage.ts');return (await loadMaterials('local')).materials.some(m=>m.title==='iPad追加.pdf');});
  await page.goto('http://127.0.0.1:5198/quiz/tests/browser/materials-scope-preview.html?empty');
  const emptyPicker=page.locator('.materials-empty input[type=file]');await emptyPicker.waitFor();
  const emptyChooserEvent=page.waitForEvent('filechooser');await emptyPicker.tap();
  await (await emptyChooserEvent).setFiles({name:'初回.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)});
  await page.waitForFunction(async()=>{const {loadMaterials}=await import('/quiz/src/utils/materialStorage.ts');return (await loadMaterials('empty')).materials.some(m=>m.title==='初回.pdf');});
  assert.deepEqual(errors,[]);
  console.log(`PASS (${engine}): touch batch registration, unlink, focused-menu relink, persisted references, Escape, Tab blur, cancelled touch, outside tap, native PDF picker and persisted PDF imports`);
} finally {await browser.close();await server.close();}
