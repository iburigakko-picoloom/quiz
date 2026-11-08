import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5211', '--strictPort'], { stdio:['ignore','pipe','pipe'], windowsHide:true });
let browser;
try {
  await new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(Error('server timeout')),30000); server.stdout.on('data', data=>{if(data.toString().includes('5211')){clearTimeout(timer);resolve();}});server.once('exit',reject); });
  browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{width:390,height:844}, reducedMotion:'reduce' }), errors=[];
  page.on('pageerror', error=>errors.push(error.message)); await page.route('https://**/*', route=>route.abort());
  await page.goto('http://127.0.0.1:5211/quiz/tests/browser/companion-care-preview.html?answers=0', {waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'学習フォルダ',exact:true}).waitFor();
  await page.evaluate(async()=>{
    const {loadAppDataAsync,saveAppData}=await import('/quiz/src/storage.ts');const data=await loadAppDataAsync();
    const names=['理系の勉強','大学入試','CBT対策','定期試験'];
    data.folders=names.map((name,index)=>({id:`layout-${index}`,name,createdAt:`2026-01-0${4-index}T00:00:00.000Z`,updatedAt:`2026-01-0${4-index}T00:00:00.000Z`}));
    data.problemSets[0].folderId=data.folders[0].id;if(!await saveAppData(data))throw Error('fixture save failed');
  });
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'学習フォルダ',exact:true}).waitFor();
  await mkdir('qa/home-folder-layout',{recursive:true});
  for(const width of [320,360,390,430,768]) {
    await page.setViewportSize({width,height:844});
    const heading=await page.getByRole('heading',{name:'学習フォルダ',exact:true}).boundingBox();
    const toggle=await page.getByRole('button',{name:'検索・並び替え'}).boundingBox();
    const add=await page.getByRole('button',{name:'フォルダを追加'}).boundingBox();
    const header=await page.locator('.quiz-home__header').boundingBox();
    const first=await page.locator('.quiz-home__folder-list .library-row-with-actions').first().boundingBox();
    const layout={width,headerGap:heading.y-(header.y+header.height),rowGap:first.y-(heading.y+heading.height),heading,toggle,add,first};
    await page.screenshot({path:`qa/home-folder-layout/${width}.png`});
    if(process.env.QUIZ_HOME_LAYOUT_PROBE){console.log(JSON.stringify(layout));continue;}
    assert.ok(Math.abs((heading.y+heading.height/2)-(toggle.y+toggle.height/2))<=2, 'heading and search are on the same row');
    assert.ok(heading.x+heading.width<=add.x && add.x+add.width<=toggle.x, 'heading, add and search do not overlap');
    assert.ok(toggle.x+toggle.width<=width-8, 'search stays inside viewport');
    assert.ok(layout.headerGap>=0 && layout.headerGap<=30, 'header spacing stays compact');
    assert.ok(layout.rowGap>=16 && layout.rowGap<=20, `heading to first folder is 16–20px: ${layout.rowGap}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(await page.locator('.quiz-home__folder-name').allTextContents(),['理系の勉強','大学入試','CBT対策','定期試験']);
  }
  if(!process.env.QUIZ_HOME_LAYOUT_PROBE){
    await page.setViewportSize({width:320,height:844});
    const toggle=page.getByRole('button',{name:'検索・並び替え'});await toggle.click();
    await page.getByRole('searchbox',{name:'フォルダを検索'}).fill('大学');
    assert.deepEqual(await page.locator('.quiz-home__folder-name').allTextContents(),['大学入試']);
    await page.getByRole('searchbox',{name:'フォルダを検索'}).fill('とても長い検索文字列'.repeat(8));
    const longHeading=await page.getByRole('heading',{name:'学習フォルダ',exact:true}).boundingBox(),longAdd=await page.getByRole('button',{name:'フォルダを追加'}).boundingBox(),longToggle=await page.getByRole('button',{name:/検索・並び替え/}).boundingBox();
    assert.ok(longHeading.x+longHeading.width<=longAdd.x && longAdd.x+longAdd.width<=longToggle.x && longToggle.x+longToggle.width<=312, 'long search stays on the same row');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.getByRole('searchbox',{name:'フォルダを検索'}).fill('');
    await page.getByRole('combobox',{name:'フォルダの並び順'}).selectOption('name');
    assert.deepEqual(await page.locator('.quiz-home__folder-name').allTextContents(),['CBT対策','大学入試','定期試験','理系の勉強']);
    await page.getByRole('button',{name:'フォルダを追加'}).click();await page.getByRole('dialog',{name:'フォルダを新規作成'}).waitFor();await page.getByRole('button',{name:'キャンセル'}).click();
    await page.locator('.quiz-home__folder-main').filter({hasText:'大学入試'}).click();await page.getByRole('heading',{name:'大学入試',exact:true}).waitFor();
    await page.goBack();await page.getByRole('heading',{name:'学習フォルダ',exact:true}).waitFor();
    await page.getByRole('button',{name:'学習記録を見る'}).waitFor();await page.getByRole('button',{name:'設定',exact:true}).waitFor();
    assert.deepEqual(errors,[]);console.log('PASS: compact same-row heading, spacing, folder ordering, search, sort, navigation and mobile widths.');
  }
}finally{await browser?.close();server.kill();}
