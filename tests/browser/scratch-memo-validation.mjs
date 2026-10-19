import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';process.env.VITE_SUPABASE_ANON_KEY='fixture';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5196,strictPort:true,watch:{ignored:['**/tmp/**']}}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1024,height:900}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',r=>r.abort());
 await page.goto('http://127.0.0.1:5196/quiz/tests/browser/materials-scope-preview.html',{timeout:60000});
 const memo=page.getByRole('button',{name:'メモ',exact:true});
 assert.equal(await memo.getAttribute('aria-pressed'),'false');
 assert.equal(await memo.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
 const title=await page.locator('.materials-title').textContent();
 const pdfPage=await page.getByLabel('ページ',{exact:true}).inputValue();
 await memo.click();
 assert.equal(await memo.getAttribute('aria-pressed'),'true');
 assert.equal(await memo.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(48, 88, 148)');
 assert.equal(await page.locator('.materials-title').textContent(),title);
 assert.equal(await page.locator('.materials-controls').count(),1);
 const canvas=page.locator('.category-note-canvas');
 const ready=()=>page.waitForFunction(()=>document.querySelector('.category-note-canvas[aria-disabled="false"]'));
 const pixels=()=>canvas.evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;});
 const draw=async()=>{await ready();const b=await canvas.boundingBox();await page.mouse.move(b.x+b.width*.3,b.y+b.height*.4);await page.mouse.down();await page.mouse.move(b.x+b.width*.65,b.y+b.height*.55,{steps:12});await page.mouse.up();await page.waitForTimeout(80);};
 await ready();
 // Adjacent pages are visible during a slide. Their paper size must match the
 // active canvas, including when a narrow viewport limits the available width.
 for (const width of [1024, 390]) {
   await page.setViewportSize({ width, height: 900 });
   const sizes = await page.locator('.category-note-page').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
   for (const preview of [sizes[0], sizes[2]]) {
     assert.ok(Math.abs(preview.width - sizes[1].width) < 1, `memo preview width must match active paper at ${width}px: ${JSON.stringify(sizes)}`);
     assert.ok(Math.abs(preview.height - sizes[1].height) < 1, `memo preview height must match active paper at ${width}px`);
   }
 }
 await page.setViewportSize({ width: 1024, height: 900 });
 const tools=page.getByRole('group',{name:'筆記用具',exact:true});
 assert.equal(await tools.getByRole('button').count(),3);
 for(const name of ['マーカー','消しゴム','ペン']) {
   const button=tools.getByRole('button',{name,exact:true});await button.click();
   assert.equal(await button.getAttribute('aria-pressed'),'true');
   assert.equal(await tools.locator('[aria-pressed="true"]').count(),1);
   assert.equal(await button.locator('svg').count(),1);
   assert.equal(await page.getByRole('button',{name:'色を選ぶ',exact:true}).isDisabled(),name==='消しゴム');
 }
 assert.equal(await page.getByLabel('ページ',{exact:true}).locator('option').count(),3);
 assert.equal(await page.getByRole('button',{name:'前のページ'}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'前に追加',exact:true}).count(),0);
 await draw();const first=await pixels();assert.ok(first>100);
 await page.getByRole('button',{name:'クリア',exact:true}).click();assert.equal(await pixels(),0);
 await page.getByRole('button',{name:'戻す',exact:true}).click();await ready();assert.equal(await pixels(),first);
 await page.getByRole('button',{name:'次のページ'}).click();await ready();assert.equal(await pixels(),0);await draw();const second=await pixels();
 await page.getByRole('button',{name:'次のページ'}).click();await ready();assert.equal(await pixels(),0);assert.equal(await page.getByRole('button',{name:'次のページ'}).isDisabled(),true);
 await page.getByLabel('ページ',{exact:true}).selectOption('0');await ready();assert.equal(await pixels(),first);
 await page.getByRole('button',{name:'クリア',exact:true}).click();assert.equal(await pixels(),0);
 await page.getByLabel('ページ',{exact:true}).selectOption('1');await ready();assert.equal(await pixels(),second,'clear affects only the selected page');
 await page.getByRole('button',{name:'メモ',exact:true}).click();await ready();assert.equal(await page.getByRole('button',{name:'クリア',exact:true}).count(),0);
 assert.equal(await memo.getAttribute('aria-pressed'),'false');
 assert.equal(await page.getByLabel('ページ',{exact:true}).inputValue(),pdfPage);
 assert.equal(await page.locator('.materials-title').textContent(),title);
 await page.getByRole('button',{name:'メモ',exact:true}).click();await ready();assert.equal(await pixels(),second,'memo survives leaving and reopening');
 const saved=await page.evaluate(async()=>JSON.parse(await (await import('/quiz/src/utils/noteStorage.ts')).loadCategoryNoteRaw('quizMake:notes:local:__scratch_memo_v1')));
 assert.equal(saved.pages.length,3);assert.equal(saved.currentPageIndex,1);
 await mkdir('tmp/memo-preview',{recursive:true});
 for(const width of [1024,390,320]) {await page.setViewportSize({width,height:900});await ready();await page.waitForTimeout(150);assert.equal(await page.locator('.category-note-toolbar').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);const clear=await page.getByRole('button',{name:'クリア',exact:true}).boundingBox(),undo=await page.getByRole('button',{name:'戻す',exact:true}).boundingBox();assert.ok(clear.x>undo.x&&Math.abs(clear.y-undo.y)<5);await page.screenshot({path:`tmp/memo-preview/${width}.png`});}
 assert.deepEqual(errors,[]);console.log('PASS: fixed 3 pages, per-page ink, clear/undo, persistence, PDF controls unchanged, 1024/390/320 layouts');
} finally {await browser.close();await server.close();}
