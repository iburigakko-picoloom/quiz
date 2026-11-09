import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {mkdir} from 'node:fs/promises';
import { createServer } from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY='fixture';
const { chromium }=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5198,strictPort:true,watch:{ignored:['**/tmp/**']}}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];
 page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',r=>r.abort());
 await page.goto('http://127.0.0.1:5198/quiz/tests/browser/materials-scope-preview.html?navigation=1&library=1');
 const ready=()=>page.locator('.materials-content > .category-note-panel .category-note-canvas[aria-disabled="false"]').waitFor();
 await ready();
 const sidebar=page.locator('.materials-navigator');
 assert.deepEqual(await sidebar.getByRole('tab').allTextContents(),['問題','資料','検索']);
 assert.equal(await page.locator('.materials-view-tabs').count(),0);
 await sidebar.getByText('未登録の問題',{exact:true}).click();await sidebar.getByRole('heading',{name:'解説',exact:true}).waitFor();
 await ready();
 await mkdir('qa/pdf-sidebar',{recursive:true});
 for(const width of [390,768,1280]){await page.setViewportSize({width,height:960});const a=await sidebar.boundingBox(),b=await page.locator('.materials-workspace').boundingBox();assert.ok(Math.abs(a.width/b.width-.3)<.02);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`qa/pdf-sidebar/${width}.png`});}
 await sidebar.getByRole('tab',{name:'資料',exact:true}).click();await sidebar.locator('.materials-navigator__page img').first().waitFor();
 await sidebar.getByRole('tab',{name:'検索',exact:true}).click();await page.getByLabel('PDF内を検索',{exact:true}).fill('beta');await sidebar.getByRole('button',{name:'検索',exact:true}).click();await sidebar.locator('.materials-navigator__results button').first().click();await ready();
 assert.equal(await page.getByLabel('ページ',{exact:true}).inputValue(),'attached-second');
 await sidebar.getByRole('tab',{name:'問題',exact:true}).click();await sidebar.getByText('このページの関連問題はありません',{exact:true}).waitFor();
 await page.getByLabel('資料一覧を開閉',{exact:true}).click();assert.equal(await sidebar.count(),0);await ready();await page.getByLabel('資料一覧を開閉',{exact:true}).click();await sidebar.waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: three tabs, inline detail, PDF search/page navigation, 30% sidebar, toggle and responsive layout');
} finally {await browser.close();await server.close();}