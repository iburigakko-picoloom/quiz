import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {PDFDocument} from 'pdf-lib';

const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const doc=await PDFDocument.create();
doc.addPage().drawText('Large PDF exercise');
doc.context.register(doc.context.stream(new Uint8Array(85*1024*1024)));
const bytes=await doc.save({useObjectStreams:false});
const server=await createServer({plugins:[{name:'large-material-fixture',configureServer(server){
  server.middlewares.use('/large-test.pdf',(_request,response)=>{
    response.writeHead(200,{'Content-Type':'application/pdf','Content-Length':bytes.length});response.end(bytes);
  });
}}],server:{host:'127.0.0.1',port:5197,strictPort:true}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.on('console',m=>{if(m.text().startsWith('fixture:'))console.log(m.text());});
  await page.goto('http://127.0.0.1:5197/quiz/tests/browser/materials-scope-preview.html');
  const size=await page.evaluate(async()=>{
    const {openAppDb}=await import('/quiz/src/storage.ts');
    const {writeMeta}=await import('/quiz/src/utils/blobVault.ts');
    const {storeMaterialPdf}=await import('/quiz/src/utils/materialStorage.ts');
    const {MaterialPreviewCache}=await import('/quiz/src/utils/materialPreview.ts');
    await writeMeta(await openAppDb(),'deltaEnabled',{version:3});
    const blob=await (await fetch('/large-test.pdf')).blob();
    console.log('fixture: storing PDF');
    const material=await storeMaterialPdf('large-set',new File([blob],'large.pdf',{type:'application/pdf'}),1);
    console.log('fixture: rendering PDF');
    const cache=new MaterialPreviewCache();
    const preview=await cache.loadBackground('large-set',material.id,material.pages[0],390);
    if(!preview.url||!preview.pixelWidth)throw Error('Missing rendered page');
    const detail=await cache.renderRegion('large-set',material.id,1,{x:0,y:0,width:0.5,height:0.5},2340,new AbortController().signal);
    const bitmap=await createImageBitmap(detail);
    if(bitmap.width!==1170)throw Error('Large document zoom resolution mismatch');
    bitmap.close();
    cache.clear();
    return blob.size;
  });
  assert.ok(size>85*1024*1024);
  console.log('Rendered imported PDF',size,'bytes');
}finally{await browser.close();await server.close();}
