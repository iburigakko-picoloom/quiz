import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { PDFDocument } from 'pdf-lib';
process.env.VITE_SUPABASE_URL='https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY='fixture';
const { chromium }=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const output=resolve('tmp',`material-import-${Date.now()}`);await mkdir(output,{recursive:true});
const doc=await PDFDocument.create();for(let i=0;i<501;i++)doc.addPage([200,280]);
doc.getPages()[0].drawText('Import check',{x:20,y:200,size:16});
const pdf=Buffer.from(await doc.save()),xref=pdf.lastIndexOf('startxref');
const path=resolve(output,'large-501-pages.pdf');
await writeFile(path,Buffer.concat([pdf.subarray(0,xref),Buffer.alloc(51*1024*1024-pdf.length,32),pdf.subarray(xref)]));
const server=await createServer({cacheDir:resolve(output,'vite-cache'),optimizeDeps:{include:['react','react-dom/client','pdf-lib','pdfjs-dist']},server:{host:'127.0.0.1',port:5199,strictPort:true,watch:{ignored:['**/tmp/**']}}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1024,height:900},reducedMotion:'reduce'}),errors=[];
  page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**/*',route=>route.abort());
  await page.goto('http://127.0.0.1:5199/quiz/tests/browser/materials-scope-preview.html?library=1&empty=1');
  await page.getByText('PDFは1ファイル100MB・2000ページまで。',{exact:true}).waitFor();
  await page.evaluate(async()=>{
    const {openAppDb}=await import('/quiz/src/storage.ts'),{writeMeta}=await import('/quiz/src/utils/blobVault.ts');
    await writeMeta(await openAppDb(),'deltaEnabled',true);
  });
  await page.locator('.materials-empty input[type=file]').setInputFiles(path);
  const ready=async()=>{await page.waitForFunction(()=>document.querySelectorAll('.category-note-canvas[aria-disabled="false"]').length===1);await page.locator('.category-note-canvas[aria-disabled="false"]').waitFor();};await ready();
  const stored=await page.evaluate(async()=>{
    const {loadMaterials,materialFileKey}=await import('/quiz/src/utils/materialStorage.ts');
    const {openAppDb}=await import('/quiz/src/storage.ts');
    const {idbDone,idbResult,parseBlobNote}=await import('/quiz/src/utils/blobVault.ts');
    const index=await loadMaterials('empty'),material=index.materials[0],key=materialFileKey('empty',material.id),db=await openAppDb();
    const tx=db.transaction(['categoryNotes','appOutbox']),done=idbDone(tx);
    const raw=await idbResult(tx.objectStore('categoryNotes').get(key));await done;
    return {key,count:index.materials.length,pages:material.pages.length,last:material.pages.at(-1).id,ref:parseBlobNote(raw).blobs[0],recordBytes:raw.length};
  });
  assert.equal(stored.count,1);assert.equal(stored.pages,501);assert.equal(stored.ref.size,51*1024*1024);
  assert.equal(stored.ref.parts.length,2);assert.ok(stored.recordBytes<2000);
  await page.getByLabel('ページ',{exact:true}).selectOption(stored.last);await ready();
  assert.equal(await page.getByLabel('ページ',{exact:true}).inputValue(),stored.last);
  await page.screenshot({path:resolve(output,'imported.png')});
  await page.getByLabel('資料の操作',{exact:true}).click();await page.getByRole('button',{name:'この資料を削除',exact:true}).click();
  await page.getByRole('button',{name:'削除する',exact:true}).click();await page.locator('.materials-empty').waitFor();
  await page.reload();await page.locator('.materials-empty').waitFor();
  const deleted=await page.evaluate(async key=>{
    const {loadCategoryNoteRaw,exportCategoryNotesRaw}=await import('/quiz/src/utils/noteStorage.ts');
    const {openAppDb}=await import('/quiz/src/storage.ts');const {idbDone,idbResult}=await import('/quiz/src/utils/blobVault.ts');
    const visible=await loadCategoryNoteRaw(key),exported=await exportCategoryNotesRaw(),db=await openAppDb();
    const tx=db.transaction('appOutbox'),done=idbDone(tx),op=await idbResult(tx.objectStore('appOutbox').get(JSON.stringify(['indexedDbNotes',key])));await done;
    return {visible,exported:Object.hasOwn(exported,key),pending:op.raw};
  },stored.key);
  assert.deepEqual(deleted,{visible:null,exported:false,pending:null});assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'verified.json'),JSON.stringify({stored,deleted,errors},null,2));
  console.log(`PASS: 51 MiB / 501-page PDF imported as one material, last page opens, deletion survives reload and is excluded from export. ${output}`);
}finally{await browser.close();await server.close();}
