import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createServer } from 'vite';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY='fixture';
const { chromium }=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5198,strictPort:true,watch:{ignored:['**/tmp/**']}}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1024,height:768}});
 await page.route('https://**/*',route=>route.abort());
 await page.goto('http://127.0.0.1:5198/quiz/tests/browser/materials-scope-preview.html?navigation=1');
 const canvas=page.locator('.materials-content > .category-note-panel canvas.category-note-canvas');
 await page.locator('.category-note-canvas[aria-disabled="false"]').first().waitFor();
 const box=await canvas.boundingBox();
 await page.mouse.move(box.x+box.width*.4,box.y+box.height*.35);
 await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.45,{steps:8});await page.mouse.up();
 await page.evaluate(()=>{
   const original=HTMLImageElement.prototype.decode;
   HTMLImageElement.prototype.decode=async function(){await new Promise(resolve=>setTimeout(resolve,100));return original.call(this);};
 });
 await page.getByRole('button',{name:'戻す',exact:true}).click();
 await page.getByText('読み込み中',{exact:true}).first().waitFor({timeout:2000});
 const during=await canvas.boundingBox();
 assert.deepEqual(during,box,'undo keeps the PDF at its previous size and position');
 await page.locator('.category-note-canvas[aria-disabled="false"]').first().waitFor();
 assert.deepEqual(await canvas.boundingBox(),box);
 const previousCanvas=await canvas.elementHandle();
 await page.getByRole('button',{name:'直接追加したPDFを開く'}).evaluate(button=>button.click());
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await previousCanvas.evaluate(el=>el.isConnected),true,'following the same reference preserves the live canvas');
 assert.deepEqual(await canvas.boundingBox(),box);
 console.log('Undo preserved the material page geometry throughout repaint.');
} finally {await browser.close();await server.close();}
