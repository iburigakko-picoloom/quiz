import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5180','--strictPort'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser;
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout')),20000);server.stdout.on('data',c=>{if(c.toString().includes('5180')){clearTimeout(timer);resolve()}});server.once('exit',reject)});
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--js-flags=--max-old-space-size=256']});
 const page=await browser.newPage({viewport:{width:820,height:1180}});
 await page.goto('http://127.0.0.1:5180/quiz/tests/browser/sync-memory-preview.html');
 const result=await page.evaluate(async()=>{
   const {computeWholeRecordDigest,wholeHash}=await import('/quiz/src/utils/wholeSyncDigest.ts');
   const rows=Array.from({length:20000},(_,i)=>({key:String(i).padStart(6,'0'),collection:'localStorage',id:'fixture-'+i,position:i,raw:JSON.stringify({a:'x'.repeat(1550),z:i})}));
   let frames=0,running=true;const tick=()=>{if(running){frames++;requestAnimationFrame(tick)}};requestAnimationFrame(tick);
   const start=performance.now();const digest=await computeWholeRecordDigest(rows);const elapsed=performance.now()-start;running=false;
   const expected=await wholeHash(JSON.stringify(rows.map(r=>({collection:r.collection,id:r.id,position:r.position,value:JSON.parse(r.raw)}))));
   return {records:rows.length,rawBytes:rows.reduce((n,r)=>n+r.raw.length,0),digestMatches:digest===expected,frames,elapsedMs:Math.round(elapsed),heapLimitMiB:Math.round(performance.memory.jsHeapSizeLimit/1048576)};
 });
 assert.ok(result.digestMatches);assert.ok(result.frames>0);console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill()}
