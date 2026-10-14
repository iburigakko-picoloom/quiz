import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY='fixture';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5195,strictPort:true,watch:{ignored:['**/tmp/**']}}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1024,height:900},hasTouch:true});
 page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.abort());
 await page.goto('http://127.0.0.1:5195/quiz/tests/browser/materials-scope-preview.html');
 const ready=()=>page.waitForFunction(()=>document.querySelector('.materials-content[aria-busy="false"] .category-note-canvas')&&!document.querySelector('.materials-transition-cover')?.children.length);
 await ready();
 for(let i=0;i<2;i++) {
  await page.getByLabel('資料の操作',{exact:true}).click();
  await page.getByRole('button',{name:'後ろに白紙ページ',exact:true}).click();await ready();
 }
 await page.getByLabel('ページ',{exact:true}).selectOption({index:0});await ready();
 const cdp=await page.context().newCDPSession(page);
 const pinch=async ratio=>{
  const box=await page.locator('.materials-content > .category-note-panel .category-note-canvas').boundingBox();
  const x=box.x+box.width/2,y=box.y+box.height/2;
  const points=d=>[{x:x-d,y,id:1},{x:x+d,y,id:2}];
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(45)});
  for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(45*(1+(ratio-1)*i/8))});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 };
 const zoom=()=>page.getByRole('button',{name:'倍率をリセット'}).innerText();
 await pinch(1.4);await page.waitForTimeout(80);
 const before=await zoom();assert.equal(before,'140%');
 const scales=await page.locator('.materials-content > .category-note-panel .category-note-page').evaluateAll(rows=>rows.map(row=>new DOMMatrix(getComputedStyle(row).transform).a));
 assert.ok(scales.every(n=>Math.abs(n-1.4)<.02),'adjacent previews have the same zoom as the active page');
 const swipe=async dx=>{
  const box=await page.locator('.materials-content > .category-note-panel .category-note-page-viewport').boundingBox();
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/8,y,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 };
 const selected=()=>page.getByLabel('ページ',{exact:true}).evaluate(el=>el.selectedIndex);
 console.log('swipe next');await swipe(-150);await page.waitForFunction(()=>document.querySelector('.materials-pagination select').selectedIndex===1);await ready();assert.equal(await zoom(),before);
 console.log('swipe previous');await swipe(150);await page.waitForFunction(()=>document.querySelector('.materials-pagination select').selectedIndex===0);await ready();assert.equal(await zoom(),before);
 await pinch(2/1.4);await page.waitForTimeout(80);const high=await zoom();assert.equal(high,'200%');
 await page.getByRole('button',{name:'次のページ',exact:true}).click();await ready();assert.equal(await selected(),1);assert.equal(await zoom(),high,'button navigation retains high zoom');
 await page.getByRole('button',{name:'前のページ',exact:true}).click();await ready();assert.equal(await selected(),0);assert.equal(await zoom(),high);
 assert.deepEqual(errors,[]);
 console.log('PASS: 140% forward/back swipes, matching preview zoom, 200% forward/back buttons, no browser errors');
} finally {await browser.close();await server.close();}
