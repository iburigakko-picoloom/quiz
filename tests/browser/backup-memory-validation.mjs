import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium,webkit}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5181','--strictPort'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser;
try{
 await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('server timeout')),20000);server.stdout.on('data',c=>{if(c.toString().includes('5181')){clearTimeout(timer);done()}});server.once('exit',fail)});
 const engine=process.env.QUIZ_BACKUP_BROWSER??'chromium';
 browser=engine==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'chrome',headless:true,args:['--js-flags=--max-old-space-size=256']});
 const page=await browser.newPage({viewport:{width:820,height:1180}});page.on('console',message=>console.log(message.text()));
 page.setDefaultTimeout(60000);
 await page.goto('http://127.0.0.1:5181/quiz/tests/browser/sync-memory-preview.html');
 const timeout=setTimeout(()=>void browser.close(),60000);
 const result=await page.evaluate(async baseline=>{
  const {createCompleteFileBackup}=await import('/quiz/src/utils/backupPayload.ts');
  const repository=await import('/quiz/src/utils/backupRepository.ts');
  const {enforceBackupHistoryLimit,listBackupHistory}=await import('/quiz/src/utils/backupHistory.ts');
  const stamp='2026-10-12T00:00:00Z';
  const data={version:1,folders:[{id:'f',name:'Fixture',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'Fixture',source:'',createdAt:stamp,updatedAt:stamp}],questions:[{id:'q',setId:'s',question:'Synthetic',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,questionImageIds:['image']}],progress:[],answerLogs:[]};
  const notes={},materials=[];
  for(let i=0;i<4;i++){
   const id='pdf-'+i;materials.push({id,title:'Synthetic PDF',pages:[{id:'page-'+i,kind:'pdf',pdfPage:1}]});
   // 12 MiB PDF body per item; synthetic deterministic content, never user data.
   notes[`quizMake:notes:s:__material_pdf_${id}`]=JSON.stringify({kind:'quiz-material-file',version:1,materialId:id,updatedAt:stamp,dataUrl:'data:application/pdf;base64,'+'AQID'.repeat(4*1024*1024)});
  }
  notes['quizMake:notes:s:__materials_v1']=JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:'s',updatedAt:stamp,materials});
  const payload={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(data)},indexedDbNotes:notes};
  const image={id:'image',questionId:'q',name:'q.png',type:'image/png',addedAt:stamp,blob:new Blob([new Uint8Array(2*1024*1024)],{type:'image/png'})};
  let frames=0,running=true;const tick=()=>{if(running){frames++;requestAnimationFrame(tick)}};requestAnimationFrame(tick);
  const start=performance.now();console.log('building backup');const file=await createCompleteFileBackup(payload,[image]);console.log('saving backup');
  const text=Blob.prototype.text;let ref;
  if(baseline)ref=await repository.saveBackupPayload(file,'before-sync');
  else{
   Blob.prototype.text=async()=>{throw Error('full Blob read during sync')};
   try{ref=await repository.saveBackupPayloadReference(file,'before-sync');if(!await repository.verifySavedBackupReference(ref))throw Error('read-back mismatch')}
   finally{Blob.prototype.text=text}
   // A metadata-only listing must not request any backup value.
   const get=IDBObjectStore.prototype.get,cursor=IDBObjectStore.prototype.openCursor;
   IDBObjectStore.prototype.get=function(...args){if(this.name==='backups')throw Error('backup body read for list');return get.apply(this,args)};
   IDBObjectStore.prototype.openCursor=function(...args){if(this.name==='backups')throw Error('backup body cursor for list');return cursor.apply(this,args)};
   try{await enforceBackupHistoryLimit();if(!(await listBackupHistory()).some(r=>r.id===ref.id))throw Error('missing history')}
   finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.openCursor=cursor}
  }
  running=false;
  return {mode:baseline?'legacy':'streamed',pdfBytes:48*1024*1024,backupBytes:ref.byteSize,frames,elapsedMs:Math.round(performance.now()-start),heapLimitMiB:performance.memory?Math.round(performance.memory.jsHeapSizeLimit/1048576):null,verified:true};
 },process.env.QUIZ_BACKUP_BASELINE==='true');
 clearTimeout(timeout);
 assert.ok(result.verified);assert.ok(result.frames>0);console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill()}
