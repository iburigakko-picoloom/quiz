import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {execFileSync} from 'node:child_process';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {incomingFixture,pdfOwner,stamp} from './helpers/whole-incoming-fixture.mjs';
import {historicalMediaReason} from './fixtures/whole-sync-historical-reason.mjs';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
globalThis.window={dispatchEvent(){}};Object.defineProperty(navigator,'locks',{value:{request:async(_name,_options,run)=>run()},configurable:true});
const {openAppDb}=await import('../src/storage.ts'),db=await openAppDb();after(()=>db.close());
const {buildWholeIncomingFile}=await import('../src/utils/wholeSyncIncoming.ts');
const {createCompleteFileBackup,createImageOptionalSyncFile,validateFileBackup}=await import('../src/utils/backupPayload.ts');
const {createMaterialTransport,hydrateMaterialDownload}=await import('../src/utils/materialCloud.ts');
const {SyncDataError}=await import('../src/utils/syncDataIntegrity.ts');
const {SyncInterruptedError}=await import('../src/utils/syncInterruption.ts');
const {syncFailureReason}=await import('../src/utils/syncStatusReason.ts');
const {clearSyncAttemptStatus,publishSyncProgress,readSyncAttemptStatus,observeRecordSyncAttempt,publishSyncAttempt}=await import('../src/utils/syncAttemptStatus.ts');
const connection={project:'https://fixture.test',userId:pdfOwner,syncId:'a'.repeat(36)};
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
const build=(fixture,progress,allow=false)=>buildWholeIncomingFile(db,fixture.rows,fixture.transport,async()=>{},progress,allow);

test('the historical 16/16 generic image error is reproducibly misclassified as PDF; typed failure corrects it',async()=>{
  const failure={code:'invalid_response',step:'backup',message:'クラウドの画像・教材を完全に退避できないため、同期を中止しました。両方の原本を保持しています。 完全な復元に必要な画像・PDF・資料が不足しています。'};
  assert.equal(historicalMediaReason(failure.message),'クラウドのPDFを読み込めません。');assert.ok(!syncFailureReason(failure).includes('PDF'));
  const fixture=await incomingFixture({image:true});fixture.rows.push({key:'["questionImages","image"]',collection:'questionImages',id:'image',raw:'{}',position:0,revision:1});
  const events=[];await assert.rejects(build(fixture,p=>events.push(p)),e=>e.code==='image_missing'&&syncFailureReason({code:e.code,message:e.message})==='一部の画像を確認できません。');
  assert.equal(fixture.downloaded,16);assert.ok(events.some(p=>p.stage==='receiving_materials'&&p.completed===16));assert.equal(events.at(-1).stage,'building_backup');
});

test('an indexed seventeenth missing PDF and orphan material reference block before downloading valid PDFs',async()=>{
  for(const options of [{missingPdf:true},{badRef:true}]){
    const fixture=await incomingFixture(options);
    await assert.rejects(build(fixture),e=>e.code===(options.missingPdf?'pdf_missing':'material_reference'));
    assert.equal(fixture.downloaded,0);assert.ok(fixture.rows.every(row=>row.raw!==null));
  }
});

test('missing image metadata and invalid note data are distinct permanent failures, including re-execution',async()=>{
  const fixture=await incomingFixture({image:true});await assert.rejects(build(fixture),e=>e.code==='image_reference');assert.equal(fixture.downloaded,0);
  const notes=await incomingFixture();notes.rows.push({key:'["indexedDbNotes","quizMake:notes:s:bad"]',collection:'indexedDbNotes',id:'quizMake:notes:s:bad',raw:'{"private":"body"}',position:17,revision:1});
  for(let i=0;i<2;i++)await assert.rejects(build(notes),e=>e.code==='note_integrity'&&!e.message.includes('private'));
  const updates=[];await observeRecordSyncAttempt(async()=>{throw new SyncDataError('material_reference','資料の紐づけ情報に不備があります。',{function:'materialReferences',stage:'material_references',cause:'reference'});},p=>updates.push(p));
  assert.equal(updates.at(-1).phase,'paused');assert.equal(updates.at(-1).lastFailure.diagnostic.cause,'reference');
});

test('local note manifest never validates the other side; local integrity checks remain intact',async()=>{
  const fixture=await incomingFixture({count:1,image:true}),hydrated=await hydrateMaterialDownload(fixture.payload,fixture.transport);
  values.set('quiz-make-note-storage-v1:manifest',JSON.stringify({version:1,keys:['quizMake:notes:s:device-only']}));
  try{
    const file=await createImageOptionalSyncFile(hydrated,[]);assert.equal(file.backupManifest.completeness,'partial');assert.equal((await validateFileBackup(file)).ok,true);
    const {getNoteBackupIssues}=await import('../src/utils/noteStorage.ts');assert.equal(getNoteBackupIssues(hydrated.indexedDbNotes).length,1);
  }finally{values.delete('quiz-make-note-storage-v1:manifest');}
});

test('PDF HTTP status, timeout and connection failures retain safe diagnostics and bounded retry delays',async()=>{
  const fixture=await incomingFixture({count:1}),file=JSON.parse(Object.values(fixture.payload.indexedDbNotes)[0]);
  for(const status of [401,403,404,500]){
    let calls=0;const waits=[];
    const transport=createMaterialTransport({url:connection.project,anonKey:'public'}, {userId:pdfOwner,accessToken:'secret'}, {fetch:async()=>{calls++;return new Response('private server',{status});},wait:async ms=>waits.push(ms)});
    await assert.rejects(transport.download(file),error=>{assert.equal(error.diagnostic.httpStatus,status);assert.ok(!JSON.stringify(error.diagnostic).includes('secret'));return true;});
    assert.equal(calls,status===500?3:1);assert.deepEqual(waits,status===500?[500,1500]:[]);
  }
  for(const name of ['TimeoutError','TypeError']){
    let calls=0;const waits=[];const transport=createMaterialTransport({url:connection.project,anonKey:'public'},{userId:pdfOwner,accessToken:'secret'},{fetch:async()=>{calls++;throw new DOMException('private body',name);},wait:async ms=>waits.push(ms)});
    await assert.rejects(transport.download(file),e=>e.code==='pdf_download'&&e.diagnostic.cause===(name==='TimeoutError'?'timeout':'network'));assert.equal(calls,3);assert.deepEqual(waits,[500,1500]);
  }
});

test('a temporary network failure recovers without altering immutable PDF bytes',async()=>{
  const fixture=await incomingFixture({count:1}),file=JSON.parse(Object.values(fixture.payload.indexedDbNotes)[0]);let calls=0;
  const transport=createMaterialTransport({url:connection.project,anonKey:'public'},{userId:pdfOwner,accessToken:'secret'},{fetch:async()=>{if(++calls===1)throw new TypeError('lost connection');return new Response(fixture.files.get(file.sha256));},wait:async()=>{}});
  assert.deepEqual(await transport.download(file),fixture.files.get(file.sha256));assert.equal(calls,2);
});

test('PDF size and SHA-256 mismatches never become successful or trigger integrity retries',async()=>{
  for(const mismatch of ['size','sha256']){
    const fixture=await incomingFixture({count:1});fixture.transport.download=async()=>new Uint8Array(mismatch==='size'?1:40).fill(99);
    await assert.rejects(build(fixture),e=>e.code==='pdf_integrity'&&e.diagnostic.cause===mismatch);
  }
});

test('verified durable PDF cache is read lazily, exact bytes reused, and another owner rejected',async()=>{
  const fixture=await incomingFixture({count:1}),[key,raw]=Object.entries(fixture.payload.indexedDbNotes)[0],file=JSON.parse(raw),body=fixture.files.get(file.sha256);
  const local=JSON.stringify({kind:'quiz-material-file',version:1,materialId:file.materialId,updatedAt:stamp,dataUrl:'data:application/pdf;base64,'+Buffer.from(body).toString('base64')});
  const tx=db.transaction('categoryNotes','readwrite'),done=complete(tx);tx.objectStore('categoryNotes').put(local,key);await done;
  assert.equal((await build(fixture)).backupManifest.completeness,'complete');assert.equal(fixture.downloaded,0);
  fixture.transport.userId='22222222-2222-4222-8222-222222222222';await assert.rejects(build(fixture),e=>e.code==='permission_denied');
  const clear=db.transaction('categoryNotes','readwrite'),cleared=complete(clear);clear.objectStore('categoryNotes').delete(key);await cleared;
});

test('account change during a download preserves the source and aborts before backup creation',async()=>{
  const fixture=await incomingFixture({count:2});let changed=false;const original=fixture.transport.download;
  fixture.transport.download=async file=>{const body=await original(file);changed=true;return body;};
  await assert.rejects(buildWholeIncomingFile(db,fixture.rows,fixture.transport,async()=>{if(changed)throw new SyncInterruptedError('connection_changed','changed');}),e=>e.reason==='connection_changed');assert.equal(fixture.downloaded,1);
});

test('post-PDF validation is a real stage, stops below 100%, and only a verified done outcome reaches 100%',async()=>{
  clearSyncAttemptStatus();publishSyncAttempt(connection,{phase:'running',step:'backup'});
  const fixture=await incomingFixture();await build(fixture,p=>publishSyncProgress(connection,p));assert.equal(readSyncAttemptStatus(connection).progress.stage,'building_backup');assert.equal(readSyncAttemptStatus(connection).overallPercent,68);
  publishSyncAttempt(connection,{phase:'done'});assert.equal(readSyncAttemptStatus(connection).overallPercent,100);
});

test('multiple large PDFs remain sequential within a restricted mobile-like JS heap',()=>{
  const output=execFileSync(process.execPath,['--max-old-space-size=192','--import','./tests/helpers/typescript-imports.mjs','tests/helpers/whole-incoming-mobile.mjs'],{encoding:'utf8',timeout:30000,windowsHide:true});
  const metrics=JSON.parse(output.trim());assert.equal(metrics.pdfs,4);assert.equal(metrics.maxConcurrentDownloads,1);
});
