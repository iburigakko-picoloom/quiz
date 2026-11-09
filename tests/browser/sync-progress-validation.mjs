import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5199,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5199/quiz/tests/browser/sync-progress-preview.html');
 await page.getByText('268 分割 / 269 分割',{exact:true}).waitFor();
 assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'99');
 await mkdir('qa/sync-progress',{recursive:true});
 for(const name of ['receiving','saving','applying','auth','done']){
  await page.evaluate(name=>window.showProgress(name),name);
  const labels={receiving:'学習データを受信中',saving:'クラウドで学習データを保存中',applying:'受信した学習データを反映中',auth:'ログインを確認中',done:'同期完了'};
  await page.getByRole('progressbar',{name:labels[name],exact:true}).waitFor();
  if(name==='receiving'){await page.getByText('12.0 MB 受信済み',{exact:true}).waitFor();assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),null);}
  if(name==='auth')assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),null);
  if(name==='done')assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'100');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`qa/sync-progress/${name}.png`});
 }
 assert.deepEqual(errors,[]);console.log('PASS: per-stage counts, receive bytes, unknown totals, completion and mobile layout');
}finally{await browser.close();await server.close();}
