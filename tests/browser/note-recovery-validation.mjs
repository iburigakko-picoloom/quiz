import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';

process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY='fixture';
const engines=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const engine=process.env.QUIZ_NOTE_BROWSER??'chromium';
const server=await createServer({server:{host:'127.0.0.1',port:5195,strictPort:true,watch:{ignored:['**/tmp/**']}}});
await server.listen();
let browser;
const output=`tmp/note-recovery-${Date.now()}`;
try{
  browser=await engines[engine].launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
  const page=await browser.newPage({viewport:{width:820,height:1180}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**/*',route=>route.abort());
  await page.goto('http://127.0.0.1:5195/quiz/tests/browser/materials-scope-preview.html');
  await page.getByText('脳神経.pdf',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.category-note-canvas')&&!document.querySelector('.category-note-save-state--saving'));
  await page.evaluate(async()=>{
    const {openAppDb}=await import('/quiz/src/storage.ts');
    const {annotationCategory}=await import('/quiz/src/utils/materialStorage.ts');
    window.recoveryKey=`quizMake:notes:other:${annotationCategory('linked','linked-page')}`;
    const canvas=document.createElement('canvas');canvas.width=200;canvas.height=280;
    const context=canvas.getContext('2d');context.fillStyle='#234';context.fillRect(20,30,120,12);
    const candidate=JSON.stringify({dataUrl:canvas.toDataURL('image/png'),updatedAt:'2020-01-01T00:00:00Z'});
    const db=await openAppDb(),key=window.recoveryKey,recordKey=JSON.stringify(['indexedDbNotes',key]);
    const tx=db.transaction(['categoryNotes','categoryNoteBackups','appRecords','appOutbox'],'readwrite'),raw=tx.objectStore('categoryNotes').get(key);
    raw.onsuccess=()=>{window.recoveryRaw=candidate;tx.objectStore('categoryNoteBackups').put(candidate,key);tx.objectStore('categoryNotes').delete(key);tx.objectStore('appRecords').delete(recordKey);tx.objectStore('appOutbox').delete(recordKey);};
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
  });
  await page.getByRole('button',{name:'既存の参照先を開く',exact:true}).click();
  await page.getByRole('region',{name:'このノートの復旧候補'}).waitFor();
  assert.equal(await page.locator('.category-note-canvas[aria-disabled="true"]').count(),1);
  await mkdir(output,{recursive:true});
  await page.screenshot({path:`${output}/candidate.png`,fullPage:true});
  // The rest of the learner remains usable; leaving does not restore or enqueue it.
  await page.locator('.materials-close').click();
  await page.waitForFunction(()=>!document.querySelector('.materials-drawer.is-open'));
  const untouched=await page.evaluate(async()=>{
    const db=await(await import('/quiz/src/storage.ts')).openAppDb(),tx=db.transaction(['categoryNotes','appOutbox']);
    const current=tx.objectStore('categoryNotes').get(window.recoveryKey),pending=tx.objectStore('appOutbox').get(JSON.stringify(['indexedDbNotes',window.recoveryKey]));
    await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});return !current.result&&!pending.result;
  });
  assert.ok(untouched);
  await page.getByRole('button',{name:'既存の参照先を開く',exact:true}).click();
  await page.getByRole('button',{name:'この内容を復元',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.category-note-recovery')&&document.querySelector('.category-note-canvas[aria-disabled="false"]'));
  const restored=await page.evaluate(async()=>{
    const db=await(await import('/quiz/src/storage.ts')).openAppDb(),tx=db.transaction(['categoryNotes','categoryNoteBackups','appOutbox']);
    const current=tx.objectStore('categoryNotes').get(window.recoveryKey),backup=tx.objectStore('categoryNoteBackups').get(window.recoveryKey),pending=tx.objectStore('appOutbox').get(JSON.stringify(['indexedDbNotes',window.recoveryKey]));
    await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});
    return {newEdit:!!pending.result&&pending.result.raw===current.result,body:JSON.parse(current.result).dataUrl===JSON.parse(window.recoveryRaw).dataUrl,newTime:JSON.parse(current.result).updatedAt!==JSON.parse(window.recoveryRaw).updatedAt,originalRetained:backup.result===window.recoveryRaw};
  });
  assert.deepEqual(restored,{newEdit:true,body:true,newTime:true,originalRetained:true});
  assert.deepEqual(errors,[]);
  await writeFile(`${output}/verified.json`,JSON.stringify({engine,untouched,restored,errors},null,2));
  console.log(JSON.stringify({output,engine,untouched,restored,errors}));
}finally{await browser?.close();await server.close();}
