import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5208','--strictPort'],{cwd:resolve('.'),stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,page;const errors=[];
try{
 await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('server timeout')),30000);server.stdout.on('data',data=>{if(data.toString().includes('5208')){clearTimeout(timer);ok();}});server.once('exit',fail);});
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));await page.route('https://**/*',route=>route.abort());
 await page.goto('http://127.0.0.1:5208/quiz/tests/browser/companion-care-preview.html?answers=0',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'作成',exact:true}).click();await page.getByRole('button',{name:'JSONファイルから取り込む',exact:true}).click();
 await page.locator('.create-set__field select').first().selectOption('__new__');await page.locator('[data-field=new-folder]').fill('複数教材の保存先');
 const make=title=>JSON.stringify({setTitle:title,questions:[{question:title+'の問題',choices:['A','B','C','D'],answerIndexes:[0,1],explanation:'根拠'}]});
 await page.locator('input[type=file]').setInputFiles([{name:'one.json',mimeType:'application/json',buffer:Buffer.from(make('教材一'))},{name:'two.json',mimeType:'application/json',buffer:Buffer.from(make('教材二'))}]);
 await page.getByText('取り込み予定：2件').waitFor();
 for(const width of [320,360,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const submit=await page.getByRole('button',{name:'取り込む',exact:true}).boundingBox(),nav=await page.locator('.primary-bottom-nav').boundingBox();assert.ok(submit&&nav&&submit.y+submit.height<=nav.y);}
 await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('button',{name:'複数ファイルの取り込みを再開'}).waitFor();await page.getByRole('button',{name:'複数ファイルの取り込みを再開'}).click();await page.getByText('取り込み予定：2件').waitFor();
 await page.getByRole('button',{name:'取り込む',exact:true}).click();await page.getByText('失敗：0件').waitFor();await page.getByRole('button',{name:'作成画面へ戻る'}).click();
 const state=await page.evaluate(async()=>await (await import('/quiz/src/storage.ts')).loadAppDataAsync());
 assert.equal(state.folders.filter(folder=>folder.name==='複数教材の保存先').length,1);
 const folder=state.folders.find(item=>item.name==='複数教材の保存先');const saved=state.problemSets.filter(set=>set.folderId===folder.id);assert.deepEqual(saved.map(set=>set.title).sort(),['教材一','教材二']);
 for(const set of saved){const questions=state.questions.filter(question=>question.setId===set.id);assert.equal(questions.length,1);assert.deepEqual(questions[0].answerIndexes,[0,1]);}
 assert.ok(state.problemSets.some(set=>set.id==='s'));assert.ok(state.questions.some(question=>question.id==='q'));assert.deepEqual(errors,[]);
 console.log('PASS: real App saves both sets once in the same new folder, preserves existing data and multiple answers.');
}catch(error){if(page)console.error(await page.locator('body').innerText());console.error(errors);throw error;}finally{await browser?.close();server.kill();}
