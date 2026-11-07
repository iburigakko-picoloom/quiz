import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.QUIZMAKE_PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href:'playwright');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5178','--strictPort'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser;
try{
 await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('server timeout')),20000);server.stdout.on('data',chunk=>{if(chunk.toString().includes('5178')){clearTimeout(timer);ok()}});server.once('exit',fail)});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(120000);page.on("pageerror",error=>console.error(error.message));
 for(const scenario of ['saved','rejected','retry']){
 await page.goto('http://127.0.0.1:5178/quiz/tests/browser/activity-save-preview.html',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'わからない',exact:true}).click();
 if(scenario==='retry'){await page.evaluate(()=>window.activitySaveTest.resolve(false));await page.getByRole('button',{name:'回答の保存を再試行',exact:false}).click()}
 await page.getByRole('button',{name:'強制終了'}).click();
 assert.equal(await page.evaluate(()=>window.activitySaveTest.calls.length),0,'must wait for durable save');
 await page.evaluate(scenario=>scenario==='rejected'?window.activitySaveTest.reject():window.activitySaveTest.resolve(true),scenario);
 await page.waitForFunction(()=>window.activitySaveTest.calls.length===1);
 const calls=await page.evaluate(()=>window.activitySaveTest.calls);
 assert.equal(calls[0].durable,scenario!=='rejected');assert.equal(calls[0].answers[0].answerLogId,'stable-log');
 console.log(scenario+': PASS');
 }
}finally{await browser?.close();server.kill()}
