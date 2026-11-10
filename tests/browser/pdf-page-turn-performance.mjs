import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';process.env.VITE_SUPABASE_ANON_KEY='fixture';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5197,strictPort:true}});await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const viewport of [{width:1024,height:1200},{width:1600,height:2200}]){
 const page=await browser.newPage({viewport,deviceScaleFactor:3}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.pdfRenders=[];const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(...args){window.pdfRenders.push([this.width,this.height]);return original.apply(this,args);};});
 await page.goto('http://127.0.0.1:5197/quiz/tests/browser/materials-scope-preview.html?navigation=1&library=1');
 const ready=()=>page.waitForFunction(()=>document.querySelector('.materials-content[aria-busy="false"] .category-note-canvas[aria-disabled="false"]')&&!document.querySelector('.materials-transition-cover')?.children.length);
 await ready();await page.waitForTimeout(1600);
 const warmRenders=await page.evaluate(()=>window.pdfRenders.filter(([width])=>width<=768).length);
 assert.equal(warmRenders,2,'both navigation previews are ready');
 for(const name of ['次のページ','前のページ','次のページ','前のページ']){await page.getByRole('button',{name,exact:true}).click();await ready();}
 const renders=await page.evaluate(()=>window.pdfRenders);
 assert.equal(renders.filter(([width])=>width<=768).length,2,'page turns reuse small previews even when full-resolution images exceed cache budget');
 // Once navigation stops, the original PDF is refined at the screen resolution.
 await page.waitForTimeout(1700);
 assert.ok(await page.locator('.category-note-page--active').evaluate(node=>{
  const src=getComputedStyle(node).backgroundImage.slice(5,-2),image=new Image();image.src=src;return image.decode().then(()=>image.naturalWidth>768);
 }),'settled text retains a high-resolution PDF background');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport,navigationRenders:2,totalRenders:renders.length}));await page.close();
 }
 console.log('PASS: high-DPI page turns reuse previews and refine after settling');
}finally{await browser.close();await server.close();}
