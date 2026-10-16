import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {createRecordProtocolDatabase} from '../helpers/record-protocol-db.mjs';
import {normalizeAppData} from '../../src/utils/appDataValidation.ts';
const pg=await createRecordProtocolDatabase();
await pg.exec(await readFile(new URL('../../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../../supabase/migrations/20261015232702_quiz_delta_sync.sql',import.meta.url),'utf8'));
const stamp='2026-10-16T00:00:00Z',syncId='d'.repeat(36),connection={project:'https://fixture.invalid',userId:'owner',syncId};
const data=normalizeAppData({version:1,folders:[{id:'f',name:'Fixture',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'Fixture',source:'',createdAt:stamp,updatedAt:stamp}],questions:[{id:'q',setId:'s',question:'Synthetic question',choices:['a','b','c','d'],answerIndex:0,explanation:'',createdAt:stamp,updatedAt:stamp}],progress:[],answerLogs:[]}).data;
await pg.query('insert into public.quiz_sync_data(sync_id,data,updated_at,creator_hash) values($1,$2,$3,private.quiz_sync_actor_hash())',[syncId,JSON.stringify({version:1,localStorage:{'quiz-make-app-data-v1':JSON.stringify(data)},indexedDbNotes:{}}),stamp]);
await pg.query('select public.quiz_sync_v2_open($1,$2)',[syncId,stamp]);
let pushes=0;const requests=[];
const server=await createServer({server:{host:'127.0.0.1',port:5196,strictPort:true,watch:{ignored:['**/tmp/**']}},plugins:[{name:'delta-fixture',configureServer(server){server.middlewares.use('/fixture-delta',async(req,res)=>{
  try{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push({action:body.action,bytes:Buffer.byteLength(raw),hasDataUrl:raw.includes('data:application/pdf')});if(body.action==='push')pushes++;
    await new Promise(r=>setTimeout(r,50));const result=(await pg.query('select public.quiz_delta_sync($1,$2,$3) result',[syncId,body.action,JSON.stringify(body.request??{})])).rows[0].result;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
});}}]});await server.listen();
const engines=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href),engine=process.env.QUIZ_NOTE_BROWSER??'webkit',output=`tmp/delta-browser-${Date.now()}`;
let browser;
try{
  browser=await engines[engine].launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]),pages=await Promise.all(contexts.map(c=>c.newPage())),errors=[];
  for(const page of pages){page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().startsWith('fixture:')||m.type()==='error')console.log(m.text());});await page.goto('http://127.0.0.1:5196/quiz/tests/browser/answer-save.html');
    await page.evaluate(async({data,connection})=>{
      window.fixture={connection,data};const storage=await import('/quiz/src/storage.ts'),vault=await import('/quiz/src/utils/blobVault.ts'),delta=await import('/quiz/src/utils/deltaSync.ts');
      if(!await storage.saveAppDataAsync(data))throw Error('seed failed');const db=await storage.openAppDb();
      const transport={delta:async(action,request)=>{const r=await fetch('/fixture-delta',{method:'POST',body:JSON.stringify({action,request})});if(!r.ok)throw Error('RPC '+r.status);return r.json();}};
      const guards={assertCurrent:async()=>{},apply:async operation=>operation({})};Object.assign(window.fixture,{db,transport,guards});
      await delta.runDeltaSync(db,connection,transport,guards,true);const cursor=await vault.readMeta(db,'deltaCursor');const enabled=await transport.delta('enable',{revision:cursor.revision});if(enabled.code!=='ok')throw Error(enabled.code);
      await vault.writeMeta(db,'deltaEnabled',{connection,version:3});
    },{data,connection});
  }
  // Ten independently hashed, syntactically valid PDFs total exactly 500 MiB.
  await pages[0].bringToFront();
  const pdfCount=Number(process.env.FIXTURE_PDF_COUNT??10);
  await pages[0].evaluate(async(pdfCount)=>{
    const {db}=window.fixture,vault=await import('/quiz/src/utils/blobVault.ts');
    const padding=new Uint8Array(1024*1024).fill(32);
    for(let index=0;index<pdfCount;index++){
      const header=`%PDF-1.4\n% fixture ${index}\n`,objects=['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n','2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n','3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n'];
      const prefixBytes=50*1024*1024-1024,offsets=[prefixBytes];for(let n=1;n<3;n++)offsets.push(offsets[n-1]+objects[n-1].length);
      const xref=prefixBytes+objects.join('').length,tail=objects.join('')+`xref\n0 4\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const parts=[header];let remain=prefixBytes-header.length-1;while(remain){const size=Math.min(remain,padding.length);parts.push(padding.slice(0,size));remain-=size;}parts.push('\n',tail,' '.repeat(1024-tail.length));
      const blob=new Blob(parts,{type:'application/pdf'});if(blob.size!==50*1024*1024)throw Error('fixture size');await vault.putContentBlob(db,blob);console.log('fixture: stored PDF '+(index+1)+'/10');
    }
    window.fixture.bytes=(await vault.readMeta(db,'blobUsage'))?.bytes??0;
  },pdfCount);
  const begin=requests.length;
  const sample=await pages[0].evaluate(async()=>{
    const {db,connection,transport,guards}=window.fixture,storage=await import('/quiz/src/storage.ts'),{recordAnswer}=await import('/quiz/src/utils/quiz.ts'),{runDeltaSync}=await import('/quiz/src/utils/deltaSync.ts');
    const bytes=window.fixture.bytes,largeRead=Blob.prototype.arrayBuffer,stream=Blob.prototype.stream,originalGet=IDBObjectStore.prototype.get,originalPut=IDBObjectStore.prototype.put;let bodyReads=0,backupWrites=0;
    Blob.prototype.arrayBuffer=function(){if(this.size>=1024*1024){bodyReads++;throw Error('large body read during answer');}return largeRead.call(this);};
    Blob.prototype.stream=function(){if(this.size>=1024*1024){bodyReads++;throw Error('large body stream during answer');}return stream.call(this);};
    IDBObjectStore.prototype.get=function(...args){if(this.name==='contentBlobs'){bodyReads++;throw Error('body lookup during answer');}return originalGet.apply(this,args);};
    IDBObjectStore.prototype.put=function(...args){if(this.name==='appDataBackups'){backupWrites++;throw Error('complete backup during answer');}return originalPut.apply(this,args);};
    const samples=[],saveSamples=[],commitSamples=[];
    try{for(let index=0;index<10;index++){
      const previous=await storage.loadAppDataAsync(),id='a-'+index,result=recordAnswer(previous,previous.questions[0],[0],false,id),start=performance.now();
      const saved=await storage.saveAppDataResult(result.data,{answerChange:{previous,questionId:'q',answerLogId:id}});if(!saved.ok)throw Error(JSON.stringify(saved.failure));
      saveSamples.push(performance.now()-start);const measured={delta:async(action,request)=>{const reply=await transport.delta(action,request);if(action==='push'&&reply.state==='committed')commitSamples.push(performance.now()-start);return reply;}};
      let outcome;do{outcome=await runDeltaSync(db,connection,measured,guards);}while(outcome.status==='more');samples.push(performance.now()-start);
    }}finally{Blob.prototype.arrayBuffer=largeRead;Blob.prototype.stream=stream;IDBObjectStore.prototype.get=originalGet;IDBObjectStore.prototype.put=originalPut;}
    return {bytes,bodyReads,backupWrites,samples,saveSamples,commitSamples,answers:(await storage.loadAppDataAsync()).answerLogs.length};
  });
  assert.equal(sample.bytes,pdfCount*50*1024*1024);assert.equal(sample.bodyReads,0);assert.equal(sample.backupWrites,0);assert.equal(sample.answers,10);
  await pages[1].waitForTimeout(5000);
  await pages[1].bringToFront();
  const remote=await pages[1].evaluate(async()=>{const f=window.fixture;await(await import('/quiz/src/utils/deltaSync.ts')).runDeltaSync(f.db,f.connection,f.transport,f.guards);const data=await(await import('/quiz/src/storage.ts')).loadAppDataAsync();return {answers:data.answerLogs.length,count:data.progress[0].answeredCount};});
  assert.deepEqual(remote,{answers:10,count:10});
  const beforePushes=pushes;
  const retry=await pages[1].evaluate(async()=>{
    const f=window.fixture,storage=await import('/quiz/src/storage.ts'),{recordAnswer}=await import('/quiz/src/utils/quiz.ts'),{runDeltaSync}=await import('/quiz/src/utils/deltaSync.ts');
    const previous=await storage.loadAppDataAsync(),result=recordAnswer(previous,previous.questions[0],[1],false,'lost-response');await storage.saveAppDataResult(result.data,{answerChange:{previous,questionId:'q',answerLogId:'lost-response'}});
    let lost=false;const dropping={delta:async(action,request)=>{const reply=await f.transport.delta(action,request);if(action==='push'&&!lost&&reply.state==='committed'){lost=true;throw Error('synthetic response loss');}return reply;}};
    try{await runDeltaSync(f.db,f.connection,dropping,f.guards);}catch(e){if(e.message!=='synthetic response loss')throw e;}
    await runDeltaSync(f.db,f.connection,f.transport,f.guards);const data=await storage.loadAppDataAsync();return {lost,answers:data.answerLogs.length,count:data.progress[0].answeredCount};
  });
  assert.deepEqual(retry,{lost:true,answers:11,count:11});assert.equal(pushes-beforePushes,1);
  assert.ok(requests.slice(begin).every(r=>!r.hasDataUrl&&r.bytes<65536));assert.deepEqual(errors,[]);
  const report={engine,...sample,p95Ms:[...sample.samples].sort((a,b)=>a-b)[9],remote,retry,duplicatePushes:pushes-beforePushes-1,maxRequestBytes:Math.max(...requests.slice(begin).map(r=>r.bytes)),network:'local PostgreSQL fixture, 50 ms added per request',errors};
  await mkdir(output,{recursive:true});await writeFile(`${output}/verified.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
}finally{await browser?.close();await server.close();await pg.close();}
