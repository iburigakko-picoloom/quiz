import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
// Manual synthetic integration test, not an iPad/Safari capacity guarantee.
// Runs receive -> durable backup -> apply -> reload -> restore + exact byte
// checks -> reload -> repeat restore. Local transport never contacts production.
// QUIZ_GROWTH_HEAP controls V8 old space (the reported total heap limit differs).
// Keeping the restored file AND a second full export alive is a separate,
// higher-memory workload; this test verifies stored notes/images individually.
const {chromium}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const count=Number(process.env.QUIZ_GROWTH_QUESTIONS??30000);
const port=process.env.QUIZ_GROWTH_PORT??'5182';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',port,'--strictPort'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser,timer;
try{
 await new Promise((done,fail)=>{const timeout=setTimeout(()=>fail(Error('server timeout')),20000);server.stdout.on('data',c=>{if(c.toString().includes(port)){clearTimeout(timeout);done()}});server.once('exit',fail)});
 browser=await chromium.launch({channel:'chrome',headless:true,args:[`--js-flags=--max-old-space-size=${process.env.QUIZ_GROWTH_HEAP??512}`]});
 const page=await browser.newPage({viewport:{width:820,height:1180}});
 page.on('console',message=>console.log(new Date().toISOString(),message.text()));
 page.on('crash',()=>console.error('test browser crashed'));
 timer=setTimeout(()=>void browser.close(),240000);
 await page.goto(`http://127.0.0.1:${port}/quiz/tests/browser/sync-memory-preview.html`);
 const received=await page.evaluate(async count=>{
  const storage=await import('/quiz/src/storage.ts');
  const {stageWholePage,readWholeRows,queueWholeReplacement,readWholeBaseline}=await import('/quiz/src/utils/wholeSyncStorage.ts');
  const {prepareStagedQuestionImages}=await import('/quiz/src/utils/recordQuestionImageSync.ts');
  const {buildWholeIncomingFile}=await import('/quiz/src/utils/wholeSyncIncoming.ts');
  const {applyWholeSyncFile}=await import('/quiz/src/utils/backupPayload.ts');
  const {saveBackupPayloadReference,verifySavedBackupReference}=await import('/quiz/src/utils/backupRepository.ts');
  const {withCoordinatedDataMutation}=await import('/quiz/src/utils/dataCoordination.ts');
  const {readUserEditGeneration}=await import('/quiz/src/utils/userEditGeneration.ts');
  const {computeWholeRecordDigest}=await import('/quiz/src/utils/wholeSyncDigest.ts');
  const stamp='2026-10-12T00:00:00Z',userId='11111111-1111-4111-8111-111111111111';
  const connection={project:'https://synthetic.invalid',userId,syncId:'a'.repeat(36)};
  const empty={version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]};
  if(!await storage.saveAppDataAsync(empty))throw Error('initial save');
  const db=await storage.openAppDb();
  const row=(collection,value,position=0)=>({key:JSON.stringify([collection,value.id]),collection,id:value.id,position,revision:1,raw:JSON.stringify(value)});
  let rows=[row('folders',{id:'f',name:'Synthetic',createdAt:stamp,updatedAt:stamp}),row('problemSets',{id:'s',folderId:'f',title:'Growth test',source:'',createdAt:stamp,updatedAt:stamp})];
  for(let i=0;i<count;i++)rows.push(row('questions',{id:'q'+i,setId:'s',question:'Synthetic question '+i+' '+('問題文・日本語'.repeat(20)),choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'Explanation '+i,sourcePage:'',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,...(i<16?{questionImageIds:['image'+i]}:{})},i));
  const hash=async body=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),b=>b.toString(16).padStart(2,'0')).join('');
  const materials=[];const pdfValues=new Map();
  for(let i=0;i<4;i++){
   const id='pdf'+i,size=12*1024*1024,sha256=await hash(new Uint8Array(size).fill(i+1));pdfValues.set(sha256,i+1);
   materials.push({id,title:'Synthetic PDF',pages:[{id:'p'+i,kind:'pdf',pdfPage:1}]});
   const key=`quizMake:notes:s:__material_pdf_${id}`;
   rows.push({key:JSON.stringify(['indexedDbNotes',key]),collection:'indexedDbNotes',id:key,position:i,revision:1,raw:JSON.stringify({kind:'quiz-material-remote-file',version:1,materialId:id,updatedAt:stamp,bucket:'quiz-material-pdfs',path:`${userId}/${sha256}.pdf`,sha256,size})});
  }
  const indexKey='quizMake:notes:s:__materials_v1';rows.push({key:JSON.stringify(['indexedDbNotes',indexKey]),collection:'indexedDbNotes',id:indexKey,position:4,revision:1,raw:JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:'s',updatedAt:stamp,materials})});
  for(let i=0;i<16;i++){
   const size=256*1024,sha256=await hash(new Uint8Array(size).fill(i+1));
   rows.push(row('questionImages',{id:'image'+i,questionId:'q'+i,name:'q.png',type:'image/png',size,sha256,path:`${userId}/${sha256}.png`,addedAt:stamp},i));
  }
  rows.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const start=performance.now();let frames=0,active=true;
  const tick=()=>{if(active){frames++;requestAnimationFrame(tick)}};requestAnimationFrame(tick);
  console.log('staging '+count+' questions');
  for(let i=0;i<rows.length;i+=200){const batch=rows.slice(i,i+200);await stageWholePage(db,connection,1,i?rows[i-1].key:'',{code:'ok',revision:1,rows:batch,afterKey:batch.at(-1).key,hasMore:i+200<rows.length});}
  rows=null;
  const getAll=IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll=function(...args){if(['appPullStage','appPullMedia'].includes(this.name)&&(!args[1]||args[1]>256))throw Error('unbounded stage read');return getAll.apply(this,args)};
  let maxDownloads=0,downloads=0,pdfs=0;
  try{
   await prepareStagedQuestionImages(db,{userId,download:async d=>new Blob([new Uint8Array(d.size).fill(Number(d.id.slice(5))+1)],{type:d.type})},async()=>{});
   console.log('building incoming backup');
   const incoming=await readWholeRows(db,connection,1);
   const file=await buildWholeIncomingFile(db,incoming,{userId,cacheScope:crypto.randomUUID(),download:async d=>{maxDownloads=Math.max(maxDownloads,++downloads);try{pdfs++;return new Uint8Array(d.size).fill(pdfValues.get(d.sha256))}finally{downloads--}}},async()=>{});
   console.log('saving and verifying incoming backup');
   const ref=await saveBackupPayloadReference(file,'before-sync');if(!await verifySavedBackupReference(ref))throw Error('backup verification');
   console.log('applying incoming snapshot');
   console.log('reading generation');const generation=await readUserEditGeneration(db);console.log('hashing incoming rows');
   const digestWatch=setInterval(()=>console.log('digest heap',Math.round(performance.memory.usedJSHeapSize/1048576)),15000);
   let digest;try{digest=await computeWholeRecordDigest(incoming)}finally{clearInterval(digestWatch)}console.log('incoming digest complete');
   const baseline={version:1,connection,serverRevision:1,userGeneration:generation,digest};
   const transaction=IDBDatabase.prototype.transaction;let dbStage='starting',lastTx;
   IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);lastTx=tx;dbStage=this.name+': '+JSON.stringify(args);tx.addEventListener('complete',()=>{if(lastTx===tx)dbStage+=' complete'});return tx;};
   const watchdog=setInterval(async()=>console.log('apply status',dbStage,JSON.stringify(await navigator.locks.query()),Math.round(performance.memory.usedJSHeapSize/1048576)+' MiB'),15000);
   let applied;try{applied=await withCoordinatedDataMutation(['app','notes'],()=>applyWholeSyncFile(file,generation,tx=>queueWholeReplacement(tx,incoming,baseline)),{requireCrossContext:true});}finally{clearInterval(watchdog);IDBDatabase.prototype.transaction=transaction}
   if(!applied.ok)throw Error(applied.error);
   const current=await storage.loadAppDataAsync();if(current.questions.length!==count||current.questions.at(-1).id!=='q'+(count-1))throw Error('question mismatch');
   if((await readWholeBaseline(db,connection)).digest!==digest)throw Error('baseline mismatch');
   active=false;
   return {questions:count,pdfs,pdfBytes:48*1024*1024,images:16,imageBytes:4*1024*1024,maxDownloads,backupBytes:ref.byteSize,backupId:ref.id,contentDigest:file.backupManifest.contentDigest,frames,elapsedMs:Math.round(performance.now()-start),heapLimitMiB:Math.round(performance.memory.jsHeapSizeLimit/1048576)};
  }finally{active=false;IDBObjectStore.prototype.getAll=getAll}
 },count);
 console.log(JSON.stringify({received}));
 await page.reload();
 const restoreRound=async ({backupId,questions})=>{
  const {getSavedBackup}=await import('/quiz/src/utils/backupRepository.ts');
  const {restoreFileBackup}=await import('/quiz/src/utils/backupPayload.ts');
  const {listWholeRecovery}=await import('/quiz/src/utils/wholeRecovery.ts');
  const {loadAppDataAsync,openAppDb}=await import('/quiz/src/storage.ts');
  const {verifyQuestionImageBlob}=await import('/quiz/src/utils/questionImageCloud.ts');
  console.log('reading backup for restore after reload');
  const file=JSON.parse((await getSavedBackup(backupId)).raw);
  let frames=0,active=true;const tick=()=>{if(active){frames++;requestAnimationFrame(tick)}};requestAnimationFrame(tick);
  const start=performance.now(),text=Blob.prototype.text;
  Blob.prototype.text=async()=>{throw Error('restore archive must not read full Blob')};
  try{
   console.log('restoring and archiving current snapshot');
   const restored=await restoreFileBackup(file);if(!restored.ok)throw Error(restored.error);
   if((await loadAppDataAsync()).questions.length!==questions)throw Error('restored count mismatch');
   const archive=await listWholeRecovery();if(archive.length!==1||!archive[0].storageDigest)throw Error('missing archive');
   console.log('verifying every restored question, PDF and image against the backup');
   if(JSON.stringify(await loadAppDataAsync())!==file.localStorage['quiz-make-app-data-v1'])throw Error('restored questions/history mismatch');
   const db=await openAppDb();
   const read=async(store,key)=>{const tx=db.transaction(store),request=tx.objectStore(store).get(key);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});return request.result;};
   for(const [key,raw] of Object.entries(file.indexedDbNotes))if(await read('categoryNotes',key)!==raw)throw Error('restored PDF/note bytes mismatch');
   for(const image of file.questionImageFiles){const saved=await read('questionImageBlobs',image.descriptor.id);if(saved?.questionId!==image.descriptor.questionId||!await verifyQuestionImageBlob(saved.blob,image.descriptor))throw Error('restored image bytes mismatch');}
   active=false;return {verified:true,questions,frames,elapsedMs:Math.round(performance.now()-start)};
  }finally{active=false;Blob.prototype.text=text}
 };
 const restored=await page.evaluate(restoreRound,received);
 console.log(JSON.stringify({restored}));
 await page.reload();
 const repeated=await page.evaluate(restoreRound,received);
 assert.ok(restored.verified);assert.ok(received.frames>0&&restored.frames>0);assert.equal(received.maxDownloads,1);
 const result={browser:'Chrome constrained heap; synthetic local transport, no production data',received,restored,repeated};
 console.log(JSON.stringify(result));
 if(process.env.QUIZ_GROWTH_RESULT)await writeFile(process.env.QUIZ_GROWTH_RESULT,JSON.stringify(result,null,2));
}finally{clearTimeout(timer);await browser?.close();server.kill()}
