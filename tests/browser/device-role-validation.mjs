import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const browser = await chromium.launch({channel:'chrome',headless:true});
const origin=process.env.QUIZMAKE_PREVIEW_ORIGIN??'http://127.0.0.1:5189/quiz';
const output=`tmp/device-role-${Date.now()}`;await mkdir(output,{recursive:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];
await context.route('https://**/*',route=>route.abort());
context.setDefaultNavigationTimeout(120000);
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
const url=`${origin}/tests/browser/companion-care-preview.html?answers=0`;
const data=target=>target.evaluate(async()=>await(await import('/quiz/src/storage.ts')).loadAppDataAsync());
const sync=async target=>{await target.getByRole('button',{name:'設定',exact:true}).click();await target.getByRole('button',{name:'同期',exact:true}).click();await target.getByRole('heading',{name:'同期',exact:true}).waitFor();};
try{
  await page.goto(url,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'作成',exact:true}).waitFor();const before=await data(page);
  // A second tab editing on this installation must prevent the role change.
  const editor=await context.newPage();await editor.goto(url,{waitUntil:'domcontentloaded'});await editor.getByRole('button',{name:'作成',exact:true}).click();
  await editor.waitForFunction(()=>!document.body.textContent.includes('保存状態を確認中…'));
  await sync(page);await page.getByRole('button',{name:'サブ端末',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'ほかの画面'}).waitFor();
  await editor.close();await page.waitForFunction(async()=>!(await navigator.locks.query()).held.some(lock=>lock.name==='quiz-make-device-role-work-v1'));await page.reload();await sync(page);await page.getByRole('button',{name:'サブ端末',exact:true}).click();
  await page.getByRole('button',{name:'サブ端末',exact:true,pressed:true}).waitFor();assert.deepEqual(await data(page),before);
  await page.screenshot({path:`${output}/sub-sync-390.png`});
  const backup=await page.evaluate(async()=>{
    const sync=await import('/quiz/src/utils/syncService.ts'),roles=await import('/quiz/src/utils/deviceRole.ts');
    const payload=await sync.exportQuizMakeData();
    if(Object.hasOwn(payload.localStorage,roles.DEVICE_ROLE_KEY))throw Error('role entered backup');
    const result=await sync.importQuizMakeData(payload);if(!result.ok)throw Error(result.error);
    return roles.readDeviceRole();
  });assert.equal(backup,'sub');assert.deepEqual(await data(page),before);
  await page.reload();await page.getByRole('button',{name:'設定',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'作成',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'フォルダを追加',exact:true}).count(),0);
  await page.locator('.quiz-home__folder-main').click();await page.getByText('確認クイズ',{exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'資料',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'登録順で解く'}).click();
  await page.locator('.quiz-choice').filter({has:page.locator('.quiz-choice__text',{hasText:/^正解$/})}).click();
  await page.getByRole('button',{name:'解答する',exact:true}).click();await page.getByRole('button',{name:'結果へ',exact:true}).click();
  assert.equal((await data(page)).answerLogs.length,before.answerLogs.length+1);
  await page.reload();await page.getByRole('button',{name:'設定',exact:true}).waitFor();
  assert.equal((await data(page)).answerLogs.length,before.answerLogs.length+1);
  await sync(page);await page.getByRole('button',{name:'メイン端末',exact:true}).click();await page.getByRole('button',{name:'メイン端末',exact:true,pressed:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'作成',exact:true}).waitFor();
  assert.equal((await data(page)).answerLogs.length,before.answerLogs.length+1);
  for(const width of [320,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({output,crossTabBlocked:true,roleSurvivesReload:true,subAnswerPersisted:true,roleChangePreservesData:true,widths:[320,390,768],errors}));
}catch(error){console.log(await page.locator('body').innerText());console.log(await page.evaluate(async()=>({phase:(await import('/quiz/src/utils/accountSync.ts')).getAccountSyncState(),protected:(await import('/quiz/src/utils/protectedWork.ts')).getActiveProtectedWorkReason(),locks:await navigator.locks.query()})));await page.screenshot({path:`${output}/failure.png`});throw error;}finally{await browser.close();}
