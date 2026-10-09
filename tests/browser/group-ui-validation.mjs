import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const packagePath=process.env.QUIZMAKE_PLAYWRIGHT_MODULE;
const {chromium}=await import(packagePath ? pathToFileURL(resolve(packagePath,'index.mjs')).href : 'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const previewOrigin=process.env.QUIZMAKE_GROUP_PREVIEW_ORIGIN??'http://127.0.0.1:5174';
await mkdir('tmp',{recursive:true});
try {
  for(const width of [390,320,768]) {
    const page=await browser.newPage({viewport:{width,height:844}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(previewOrigin+'/quiz/tests/browser/group-ui-preview.html');
    await page.getByRole('tab',{name:'概要',exact:true}).waitFor();
    const checkOverflow=async()=>assert.equal(await page.locator('.app-layout__scroll').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`${width}px horizontal overflow`);
    await checkOverflow();await page.screenshot({path:`tmp/group-ui-${width}-overview.png`});
    await page.getByRole('button',{name:'自分',exact:true}).click();await page.getByText('教材を学習すると、ここで進捗を確認できます。').waitFor();
    await page.getByRole('button',{name:'全体',exact:true}).click();
    await page.getByRole('tab',{name:/メンバー/}).click();assert.equal(await page.locator('.group-member-card').count(),8);await checkOverflow();
    assert.equal(await page.locator('.group-member-card').first().locator('strong').innerText(),'あなた');
    await page.getByRole('button',{name:'L3',exact:true}).click();assert.equal(await page.locator('.group-member-card').first().locator('strong').innerText(),'鈴木');
    await page.getByRole('button',{name:'今週',exact:true}).click();assert.equal(await page.locator('.group-member-card').first().locator('strong').innerText(),'あなた');
    await page.screenshot({path:`tmp/group-ui-${width}-members.png`});
    await page.getByRole('tab',{name:/フォルダ/}).click();await checkOverflow();await page.screenshot({path:`tmp/group-ui-${width}-folders.png`});
    await page.locator('.group-folder-card__open').first().click();assert.equal(await page.locator('.group-set-row').count(),3);assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#group-panel-folders h2')),true,'Folder destination receives focus');assert.equal(await page.locator('#group-panel-folders .library-pane').evaluate(el=>getComputedStyle(el).animationName),'quizScreenForwardIn');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#group-panel-folders .library-pane').evaluate(el=>getComputedStyle(el).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('.group-set-row').first().click();await page.getByRole('button',{name:'取り込む',exact:true}).waitFor();await checkOverflow();
    assert.equal(await page.locator('.group-preview-card').count(),3);assert.equal(await page.locator('.group-progress-member').count(),5);
    await page.screenshot({path:`tmp/group-ui-${width}-set.png`});
    await page.mouse.move(width/2,400);await page.mouse.wheel(0,1200);
    await page.waitForFunction(()=>document.querySelector('.community-screen--group-workspace').scrollTop>0);
    const progressBox=await page.getByRole('heading',{name:'メンバーの進捗',exact:true}).boundingBox();assert.ok(progressBox.y>64&&progressBox.y+progressBox.height<770,'Imported member progress can be scrolled into view');
    await page.screenshot({path:`tmp/group-ui-${width}-progress.png`});
    await page.getByRole('heading',{name:'問題プレビュー',exact:true}).scrollIntoViewIfNeeded();
    await page.locator('.group-preview-card button').first().click();assert.equal(await page.locator('.group-preview-card__expanded li').count(),4);
    await page.getByRole('button',{name:/すべて見る（45問）/}).click();assert.equal(await page.locator('.group-preview-card').count(),45);
    await page.getByRole('button',{name:'3問だけ見る',exact:true}).click();
    await page.getByRole('button',{name:'戻る',exact:true}).click();assert.equal(await page.locator('.group-set-row').count(),3);
    await page.getByRole('button',{name:'戻る',exact:true}).click();assert.equal(await page.locator('.group-folder-card').count(),3);
    for(const state of ['empty','member-empty']){await page.goto(previewOrigin+'/quiz/tests/browser/group-ui-preview.html?state='+state);await page.getByRole('button',{name:'1人のメンバーを見る'}).waitFor();assert.equal(await page.getByRole('heading',{name:'今日の解答数',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'フォルダを追加',exact:true}).count(),state==='empty'?1:0);await checkOverflow();await page.screenshot({path:`tmp/group-ui-${width}-${state}.png`});await page.getByRole('button',{name:'1人のメンバーを見る'}).click();assert.equal(await page.locator('.group-member-card').count(),1);await page.getByRole('tab',{name:'概要',exact:true}).click();await page.getByRole('button',{name:'0個のフォルダを見る'}).click();assert.equal(await page.getByRole('tab',{name:/フォルダ/}).getAttribute('aria-selected'),'true');}
    assert.deepEqual(errors,[],`Browser errors at ${width}px`);await page.close();console.log(`${width}px: tabs, sorting, preview, folder navigation and overflow passed`);
  }
} finally {await browser.close();}
