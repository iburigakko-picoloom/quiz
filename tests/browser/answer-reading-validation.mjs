import assert from 'node:assert/strict';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {mkdir} from 'node:fs/promises';import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=await createServer({server:{host:'127.0.0.1',port:5196,strictPort:true}});await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',r=>r.abort());
 await page.goto('http://127.0.0.1:5196/quiz/tests/browser/answer-reading-preview.html');
 await page.locator('.quiz-choice').first().click();await page.getByRole('button',{name:'解答する',exact:true}).click();
 const sheet=page.locator('.answer-sheet');await page.locator('.answer-sheet--expanded').waitFor();
 await page.getByRole('heading',{name:'重要事項',exact:true}).waitFor();assert.equal(await sheet.getByRole('heading',{name:'ポイント',exact:true}).count(),0);assert.equal(await sheet.getByRole('heading',{name:'尿の生成と調節',exact:true}).count(),0);
 await page.getByText('消してはいけない旧形式の説明。',{exact:true}).waitFor();
 assert.equal(await sheet.locator('.answer-sheet__choice-card').count(),4);assert.equal(await sheet.locator('.answer-sheet__choice-card.is-correct').count(),2);
 for(const card of await sheet.locator('.answer-sheet__choice-card').all()){const title=await card.locator('.answer-sheet__choice-statement').innerText();const choice=['腎臓','尿管','膀胱','別'].findIndex(x=>title.includes(x));assert.ok((await card.innerText()).includes(`判断条件${choice+1}`));}
 assert.equal(await sheet.locator('.answer-sheet__important strong').first().evaluate(el=>getComputedStyle(el).color),'rgb(185, 83, 12)');
 await mkdir('qa/answer-reading',{recursive:true});
 for(const width of [320,390,768]){await page.setViewportSize({width,height:844});await page.screenshot({path:`qa/answer-reading/${width}.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const body=await sheet.locator('.answer-sheet__scroll').boundingBox(),footer=await sheet.locator('.answer-sheet__actions').boundingBox();assert.ok(body.y+body.height<=footer.y+1);}
 await page.setViewportSize({width:390,height:844});
 await sheet.getByRole('heading',{name:'選択肢の検討',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'qa/answer-reading/cards.png'});await sheet.locator('.answer-sheet__content-page').first().evaluate(el=>{el.scrollTop=0;});
 const handle=sheet.locator('.answer-sheet__drag-area');await handle.click();await page.locator('.answer-sheet--default').waitFor();await handle.click();await page.locator('.answer-sheet--expanded').waitFor();
 const cdp=await page.context().newCDPSession(page);
 const swipe=async(locator,delta)=>{const b=await locator.boundingBox();const x=b.x+b.width/2,y=b.y+b.height/2;await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+delta*i/12,id:1}]});await page.waitForTimeout(25);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(350);};
 await swipe(sheet.locator('.answer-sheet__content-page').first(),-180);assert.ok(await sheet.locator('.answer-sheet__content-page').first().evaluate(el=>el.scrollTop>0));assert.ok(await sheet.evaluate(el=>el.classList.contains('answer-sheet--expanded')));
 await swipe(handle,350);assert.ok(!(await sheet.evaluate(el=>el.classList.contains('answer-sheet--expanded'))));
 if(await sheet.evaluate(el=>el.classList.contains('answer-sheet--hidden')))await sheet.getByRole('button',{name:'解答を見る',exact:true}).click();
 if(await sheet.evaluate(el=>el.classList.contains('answer-sheet--default')))await sheet.locator('.answer-sheet__drag-area').click();
 await sheet.getByRole('button',{name:'右側の追加解説・メモへ',exact:true}).click();await sheet.getByRole('heading',{name:'追加解説・メモ',exact:true}).waitFor();await sheet.getByRole('button',{name:'左側の解答に戻る',exact:true}).click();
 await sheet.getByRole('button',{name:'次へ',exact:true}).click();await sheet.waitFor({state:'detached'});
 await page.locator('.quiz-choice').first().click();await page.getByRole('button',{name:'解答する',exact:true}).click();await page.locator('.answer-sheet--expanded').waitFor();await page.getByText('通常の解説',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.unsafeExecuted),undefined);assert.equal(await sheet.locator('a[href^="javascript:"]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: expanded answers, legacy/new content, shuffled multi-answer cards, touch scroll/drag, tap, footer and memo navigation');
}finally{await browser.close();await server.close();}
