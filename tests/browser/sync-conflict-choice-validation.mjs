import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
process.env.VITE_SUPABASE_URL='https://sync-fixture.invalid';
process.env.VITE_SUPABASE_ANON_KEY='synthetic-client';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5197,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const side of ['local','remote']){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',route=>route.abort());
  const html=await server.transformIndexHtml('/quiz/conflict-fixture.html','<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>');
  await page.route('**/conflict-fixture.html',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('http://127.0.0.1:5197/quiz/conflict-fixture.html');
  await page.evaluate(async()=>{
   const {React,createRoot}=await import('/quiz/tests/browser/companion-sync-runtime.ts');
   const {SyncConflictRecovery}=await import('/quiz/src/components/SyncConflictRecovery.tsx');
   const storage=await import('/quiz/src/storage.ts'),model=await import('/quiz/src/utils/companionCare.ts');
   const {saveSyncedLocalStorage}=await import('/quiz/src/utils/localStorageRecords.ts');
   const {bindRecordSyncConnection}=await import('/quiz/src/utils/recordSyncOutbox.ts');
   const {SYNC_ATTEMPT_EVENT}=await import('/quiz/src/utils/syncAttemptStatus.ts');
   const {SYNC_RETRY_EVENT}=await import('/quiz/src/utils/syncRequest.ts');
   const {readCompanionCare}=await import('/quiz/src/utils/companionCareStorage.ts');
   await import('/quiz/src/screens/SyncScreen.css');
   await storage.saveAppDataAsync(storage.createEmptyAppData());const db=await storage.openAppDb();
   const connection={project:'https://sync-fixture.invalid',userId:'fixture',syncId:'1'.repeat(36)};
   await bindRecordSyncConnection(db,connection);
   const base={...model.creditCompanionAnswers(model.createCompanionCare('2026-11-09'),Array.from({length:50},(_,i)=>({id:`answer-${i}`}))),friendship:40,peakFriendship:40};
   const left={...model.applyCompanionCareAction(base,{kind:'feed'},base.lastSeenDay),name:'端末ぽん'},right={...model.applyCompanionCareAction(base,{kind:'train',trickId:'spin'},base.lastSeenDay),name:'クラウドぽん'};
   await saveSyncedLocalStorage({[model.COMPANION_CARE_KEY]:JSON.stringify(left)});
   let retries=0,busy=false;window.addEventListener(SYNC_RETRY_EVENT,()=>retries++);
   window.fixture={seed:async()=>{const tx=db.transaction('appRecordConflicts','readwrite');const row={kind:'companion-budget-conflict',connection,local:{raw:JSON.stringify(left)},remote:{raw:JSON.stringify(right)}};
    tx.objectStore('appRecordConflicts').put(row,'shown');tx.objectStore('appRecordConflicts').put({...row,connection:{...connection,syncId:'other'}},'hidden');
    await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});window.dispatchEvent(new Event(SYNC_ATTEMPT_EVENT));
   },read:async()=>{const tx=db.transaction('appRecordConflicts'),request=tx.objectStore('appRecordConflicts').get('shown');await new Promise(r=>tx.oncomplete=r);return {care:readCompanionCare(),original:request.result,retries,busy};}};
   createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement('main',{className:'sync-screen'},React.createElement(SyncConflictRecovery,{syncId:connection.syncId,accountId:connection.userId,onBusyChange:value=>{busy=value;}}))));
  });
  await page.evaluate(()=>window.fixture.seed());
  await page.getByRole('heading',{name:'育成はどちらのデータを使いますか？'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'育成はどちらのデータを使いますか？'}).count(),1);
  assert.equal(await page.getByRole('button',{name:'この育成で同期を再開'}).isEnabled(),false);
  await page.getByRole('radio',{name:side==='local'?/この端末/:/クラウド/}).check();
  await page.getByRole('button',{name:'この育成で同期を再開'}).click();
  await page.getByRole('status').filter({hasText:'選んだ育成を保存しました'}).waitFor();
  await page.waitForTimeout(100);
  const result=await page.evaluate(()=>window.fixture.read());
  assert.equal(result.care.name,side==='local'?'端末ぽん':'クラウドぽん');
  assert.equal(result.care.answerBalance,-25);assert.equal(result.care.spendEvents.length,2);
  assert.equal(result.retries,1);assert.equal(result.busy,false);assert.equal(result.original.choice,side);assert.ok(result.original.local.raw&&result.original.remote.raw&&result.original.resolvedAt);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: local/cloud choices, delayed conflict display, connection scope, original retention, combined spend, manual retry and 390px layout.');
} finally {await browser.close();await server.close();}
