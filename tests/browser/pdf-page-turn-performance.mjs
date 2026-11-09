import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';process.env.VITE_SUPABASE_ANON_KEY='fixture';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5197,strictPort:true}});await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1024,height:1200},deviceScaleFactor:2});
 await page.addInitScript(()=>{window.pdfRenders=[];const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(...args){window.pdfRenders.push([this.width,this.height]);return original.apply(this,args);};});
 await page.goto('http://127.0.0.1:5197/quiz/tests/browser/materials-scope-preview.html?navigation=1&library=1');
 const ready=()=>page.waitForFunction(()=>document.querySelector('.materials-content[aria-busy="false"] .category-note-canvas[aria-disabled="false"]')&&!document.querySelector('.materials-transition-cover')?.children.length);
 await ready();await page.waitForTimeout(700);
 const timings=[];const warmRenders=await page.evaluate(()=>window.pdfRenders.length);
 for(const name of ['次のページ','前のページ','次のページ','前のページ']){const start=Date.now();await page.getByRole('button',{name,exact:true}).click();await ready();timings.push(Date.now()-start);await page.waitForTimeout(350);}
 const renders=await page.evaluate(()=>window.pdfRenders);
 assert.equal(renders.length,warmRenders,'cached forward/back navigation must not redraw the PDF');
 assert.equal(renders.length,2,'each of the two pages is rendered once at display resolution');
 console.log('PASS: two PDF renders total, no extra renders during four page turns');
}finally{await browser.close();await server.close();}
