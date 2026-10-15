import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();
globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
globalThis.window={dispatchEvent(){}};
Object.defineProperty(globalThis.navigator,'locks',{value:{request:async(_name,_options,run)=>run()},configurable:true});
let quota=1024*1024*1024;
Object.defineProperty(globalThis.navigator,'storage',{value:{estimate:async()=>({quota,usage:0})},configurable:true});
const storage=await import('../src/storage.ts');
const notes=await import('../src/utils/noteStorage.ts');
const imageStorage=await import('../src/utils/questionImageRecords.ts');
const {exportFileBackup,validateFileBackup,restoreFileBackup}=await import('../src/utils/backupPayload.ts');
const {listWholeRecovery,getWholeRecovery,deleteWholeRecovery}=await import('../src/utils/wholeRecovery.ts');
const {saveSyncedLocalStorage}=await import('../src/utils/localStorageRecords.ts');
const {accountLocalStorage}=await import('../src/utils/accountStorage.ts');
const stamp='2026-10-05T00:00:00Z';
const question={id:'q',setId:'s',question:'old Q',choices:['a','b','c','d'],answerIndex:0,answerText:'a',explanation:'',sourcePage:'',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,questionImageIds:['i']};
const data={version:1,folders:[{id:'f',name:'F',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'S',source:'',createdAt:stamp,updatedAt:stamp}],questions:[question],progress:[],answerLogs:[]};
assert.equal(await storage.saveAppDataAsync(data),true);
const db=await storage.openAppDb();after(()=>db.close());
const image={id:'i',questionId:'q',name:'q.png',type:'image/png',blob:new Blob([Uint8Array.from([137,80,78,71])],{type:'image/png'}),addedAt:stamp};
await imageStorage.saveQuestionImage(image);
const noteKey='quizMake:notes:s:cat',raw=JSON.stringify({dataUrl:'ink-old',updatedAt:stamp});
await notes.saveCategoryNoteRaw(noteKey,raw);
await saveSyncedLocalStorage({'quiz-make-creation-notes-v1':'[]'});
values.set('quizMake:companion:enabled','false');
const original=await exportFileBackup();

test('complete export includes actual image bytes, verified descriptors, all notes and explicit counts',async()=>{
  assert.equal(original.backupManifest.completeness,'complete');assert.equal(original.backupManifest.imageCount,1);
  assert.equal(original.indexedDbNotes[noteKey],raw);assert.equal(original.localStorage['quizMake:companion:enabled'],'false');
  const checked=await validateFileBackup(JSON.parse(JSON.stringify(original)));assert.equal(checked.ok,true,checked.error);
  assert.deepEqual(Buffer.from(await checked.value.images[0].blob.arrayBuffer()),Buffer.from(await image.blob.arrayBuffer()));
  const corrupt=structuredClone(original);corrupt.questionImageFiles[0].dataUrl='data:image/png;base64,AAAAAA==';
  assert.equal((await validateFileBackup(corrupt)).ok,false);
  const missing=structuredClone(original);missing.questionImageFiles=[];assert.equal((await validateFileBackup(missing)).ok,false);
  assert.equal((await validateFileBackup({...original,backupManifest:{...original.backupManifest,imageCount:2}})).ok,false);
});

test('recovery archives stream into Blobs, verify duplicates without full reads, and support legacy strings',async()=>{
  const {prepareWholeRecovery}=await import('../src/utils/wholeRecovery.ts');
  const {jsonByteSize}=await import('../src/utils/incrementalJsonDigest.ts');
  assert.equal(await jsonByteSize(original),Buffer.byteLength(JSON.stringify(original)));
  const text=Blob.prototype.text;Blob.prototype.text=async()=>assert.fail('whole recovery verification must stream');
  let summary;
  try{
    const queue=await prepareWholeRecovery(db,original,'before-restore');
    const tx=db.transaction(['appDataBackups','appRecordMeta'],'readwrite');queue(tx);await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j;});
    summary=(await listWholeRecovery())[0];assert.match(summary.storageDigest,/^[0-9a-f]{64}$/);
    const read=db.transaction('appDataBackups'),request=read.objectStore('appDataBackups').get(summary.id);await new Promise((r,j)=>{read.oncomplete=r;read.onabort=j;});assert.ok(request.result instanceof Blob);
    await prepareWholeRecovery(db,original,'before-restore');
    const corrupt=db.transaction('appDataBackups','readwrite');corrupt.objectStore('appDataBackups').put(new Blob([new Uint8Array(summary.byteSize)]),summary.id);await new Promise((r,j)=>{corrupt.oncomplete=r;corrupt.onabort=j;});
    await assert.rejects(prepareWholeRecovery(db,original,'before-restore'),/既存/);
    // Old installations stored string bodies without storageDigest.
    const legacy=db.transaction('appDataBackups','readwrite');legacy.objectStore('appDataBackups').put(JSON.stringify(original),summary.id);await new Promise((r,j)=>{legacy.oncomplete=r;legacy.onabort=j;});
    await prepareWholeRecovery(db,original,'before-restore');
  }finally{Blob.prototype.text=text;}
  assert.deepEqual(JSON.parse(await getWholeRecovery(summary.id)),original);
  await deleteWholeRecovery(summary.id);
});

test('one shared transaction replaces app/notes/images/settings and stores a fully restorable pre-restore copy',async()=>{
  assert.equal(await storage.saveAppDataAsync({...data,questions:[{...question,question:'new Q'}]}),true);
  await notes.saveCategoryNoteRaw(noteKey,JSON.stringify({dataUrl:'ink-new',updatedAt:'2026-10-05T01:00:00Z'}));
  values.set('quizMake:companion:enabled','true');
  await saveSyncedLocalStorage({'quiz-make-creation-notes-v1':JSON.stringify([{id:'memo',questionId:'q',title:'memo',body:'old memo'}])});
  const result=await restoreFileBackup(original);assert.equal(result.ok,true,result.error);
  assert.equal((await storage.loadAppDataAsync()).questions[0].question,'old Q');
  assert.equal(await notes.loadCategoryNoteRaw(noteKey),raw);assert.equal(values.get('quizMake:companion:enabled'),'false');
  assert.equal(accountLocalStorage.getItem('quiz-make-creation-notes-v1'),'[]');
  const list=await listWholeRecovery();assert.equal(list.length,1);assert.equal(list[0].kind,'before-restore');
  const previous=await validateFileBackup(JSON.parse(await getWholeRecovery(list[0].id)));assert.equal(previous.ok,true,previous.error);
  assert.equal(JSON.parse(previous.value.payload.localStorage['quiz-make-app-data-v1']).questions[0].question,'new Q');
  assert.equal(previous.value.payload.questionImageFiles.length,1);
  // Repeating the same restore preserves a second, deduplicated content state.
  assert.equal((await restoreFileBackup(original)).ok,true);const count=(await listWholeRecovery()).length;
  assert.equal((await restoreFileBackup(original)).ok,true);assert.equal((await listWholeRecovery()).length,count);
});

test('restoring a snapshot removes obsolete note backups; older restores recover only proven deletions',async()=>{
  const priorArchives=new Set((await listWholeRecovery()).map(row=>row.id));
  const key='quizMake:notes:s:removed',orphan='quizMake:notes:s:unknown';
  await notes.saveCategoryNoteRaw(key,raw);
  await notes.saveCategoryNoteRaw(key,JSON.stringify({dataUrl:'later',updatedAt:'2026-10-06T00:00:00Z'}));
  assert.equal((await restoreFileBackup(original)).ok,true);
  assert.equal((await notes.exportCategoryNotesRaw())[key],undefined);
  assert.equal(await notes.loadCategoryNoteRaw(key),null);
  const read=db.transaction('categoryNoteBackups'),count=read.objectStore('categoryNoteBackups').count();
  await new Promise((r,j)=>{read.oncomplete=r;read.onabort=j;});assert.equal(count.result,0);
  // Simulate the leftover backup and diagnostic marker from an older build.
  async function putBackup(id){const tx=db.transaction('categoryNoteBackups','readwrite');tx.objectStore('categoryNoteBackups').put(raw,id);await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j;});}
  await putBackup(key);
  accountLocalStorage.setItem(notes.CATEGORY_NOTES_RECOVERY_REQUIRED_KEY,JSON.stringify({version:1,reason:'backup-only'}));
  assert.equal(await notes.loadCategoryNoteRaw(key),null);
  assert.equal((await notes.exportCategoryNotesRaw())[key],undefined);
  assert.equal(accountLocalStorage.getItem(notes.CATEGORY_NOTES_RECOVERY_REQUIRED_KEY),null);
  assert.equal((await notes.exportCategoryNotesRaw({mode:'recovery'}))[key],raw,'recovery retains the old original');
  await putBackup(orphan);
  await assert.rejects(notes.exportCategoryNotesRaw(),/バックアップにしか/);
  assert.equal((await notes.exportCategoryNotesRaw({mode:'recovery'}))[orphan],raw);
  const tx=db.transaction('categoryNoteBackups','readwrite');tx.objectStore('categoryNoteBackups').clear();await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j;});
  accountLocalStorage.removeItem(notes.CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
  for(const row of await listWholeRecovery())if(!priorArchives.has(row.id))await deleteWholeRecovery(row.id);
});

test('a newer durable native note fallback is archived before restore and cannot supersede the chosen restored note',async()=>{
  const fallback=JSON.stringify({dataUrl:'fallback-newer',updatedAt:'2030-01-01T00:00:00Z'});
  values.set(noteKey,fallback);
  const result=await restoreFileBackup(original);assert.equal(result.ok,true,result.error);
  assert.equal(values.has(noteKey),false);assert.equal(await notes.loadCategoryNoteRaw(noteKey),raw);
  let found=false;for(const row of await listWholeRecovery()){const file=JSON.parse(await getWholeRecovery(row.id));if(file.indexedDbNotes[noteKey]===fallback)found=true}
  assert.equal(found,true,'sole newer fallback survives in the complete local copy');
});

test('a real 25 MiB PDF and its index survive file export, whole restore and local recovery without the 32 MiB base64 regression',async()=>{
  for(const row of await listWholeRecovery())await deleteWholeRecovery(row.id);
  const key='quizMake:notes:s:__material_pdf_pdf';
  const pdf=JSON.stringify({kind:'quiz-material-file',version:1,materialId:'pdf',updatedAt:stamp,dataUrl:'data:application/pdf;base64,'+Buffer.alloc(25*1024*1024,7).toString('base64')});
  const indexKey='quizMake:notes:s:__materials_v1';
  const index=JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:'s',updatedAt:stamp,materials:[{id:'pdf',title:'PDF',pages:[{id:'page',kind:'pdf',pdfPage:1}]}]});
  await notes.saveCategoryNoteRaw(key,pdf);await notes.saveCategoryNoteRaw(indexKey,index);
  const file=await exportFileBackup();assert.ok(Buffer.byteLength(JSON.stringify(file))>32*1024*1024);
  assert.equal((await validateFileBackup(JSON.parse(JSON.stringify(file)))).ok,true);
  assert.equal((await restoreFileBackup(original)).ok,true);
  const previous=JSON.parse(await getWholeRecovery((await listWholeRecovery())[0].id));assert.equal(previous.indexedDbNotes[key],pdf);
  assert.equal((await restoreFileBackup(file)).ok,true);assert.equal(await notes.loadCategoryNoteRaw(key),pdf);assert.equal(await notes.loadCategoryNoteRaw(indexKey),index);
  assert.equal((await restoreFileBackup(original)).ok,true);
});

test('current PDF and material failures retain typed local diagnostics and leave every original unchanged on repeated restore',async()=>{
  const {readAppRecordSnapshot,readAppOutbox}=await import('../src/utils/appRecordStorage.ts');
  const beforeNotes=await notes.exportCategoryNotesRaw();
  const cases=[
    {set:'s',code:'pdf_missing',reason:'missing_pdf',pages:[{id:'p',kind:'pdf',pdfPage:1}]},
    {set:'orphan',code:'material_reference',reason:'missing_owner',pages:[{id:'p',kind:'blank'}]},
  ];
  for(const fixture of cases){
    const key=`quizMake:notes:${fixture.set}:__materials_v1`,index=JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:fixture.set,updatedAt:stamp,materials:[{id:'missing',title:'Private title must not enter diagnostics',pages:fixture.pages}]});
    await notes.saveCategoryNoteRaw(key,index);
    const current=await storage.loadAppDataAsync(),snapshot=await readAppRecordSnapshot(db),outbox=await readAppOutbox(db),copies=await listWholeRecovery();
    try{for(let attempt=0;attempt<2;attempt++){
      const result=await restoreFileBackup(original);
      assert.equal(result.ok,false);assert.equal(result.committed,false);assert.equal(result.code,fixture.code);
      assert.equal(result.diagnostic.function,'replaceCompleteFile');assert.equal(result.diagnostic.stage,'local_backup_validate');assert.equal(result.diagnostic.side,'local');
      assert.equal(result.diagnostic.referenceIssues[0].reason,fixture.reason);assert.equal(result.diagnostic.referenceIssues[0].problemSetId,fixture.set);
      assert.ok(!JSON.stringify(result.diagnostic).includes('Private title'));
      assert.deepEqual(await storage.loadAppDataAsync(),current);assert.deepEqual(await readAppRecordSnapshot(db),snapshot);assert.deepEqual(await readAppOutbox(db),outbox);
      assert.equal(await notes.loadCategoryNoteRaw(key),index);assert.deepEqual(await listWholeRecovery(),copies);
    }}finally{await notes.replaceCategoryNotesRaw(beforeNotes);}
  }
});

test('quota failure while archiving aborts every store and keeps the current copy',async()=>{
  assert.equal(await storage.saveAppDataAsync({...data,questions:[{...question,question:'quota Q'}]}),true);
  const before=await exportFileBackup(),list=await listWholeRecovery(),put=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(value,...args){if(this.name==='appDataBackups'&&String(args[0]).startsWith('quizMake:wholeRecovery:'))throw new DOMException('quota','QuotaExceededError');return put.call(this,value,...args)};
  let result;try{result=await restoreFileBackup(original)}finally{IDBObjectStore.prototype.add=put}
  assert.equal(result.ok,false);assert.equal(result.committed,false);
  assert.equal((await exportFileBackup()).backupManifest.contentDigest,before.backupManifest.contentDigest);
  assert.deepEqual(await listWholeRecovery(),list);
});

test('available capacity and incomplete images stop replacement; partial rescue files cannot overwrite',async()=>{
  quota=1;const before=(await storage.loadAppDataAsync()).questions[0].question;
  assert.equal((await restoreFileBackup(original)).ok,false);assert.equal((await storage.loadAppDataAsync()).questions[0].question,before);quota=1024*1024*1024;
  const tx=db.transaction('questionImageBlobs','readwrite'),done=new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j});tx.objectStore('questionImageBlobs').delete('i');await done;
  await assert.rejects(exportFileBackup(),error=>error.code==='image_missing'&&error.diagnostic.function==='exportFileBackup'&&error.diagnostic.side==='local'&&error.diagnostic.total===1&&error.diagnostic.completed===0);
  const partial=await exportFileBackup({recovery:true});assert.equal(partial.backupManifest.completeness,'partial');
  assert.equal((await validateFileBackup(partial)).ok,true);assert.equal((await restoreFileBackup(partial)).ok,false);
  assert.equal((await restoreFileBackup(original)).ok,false,'cannot discard current data without a complete recovery copy');
  await imageStorage.saveQuestionImage(image);
  for(const row of await listWholeRecovery())await deleteWholeRecovery(row.id);
  assert.deepEqual(await listWholeRecovery(),[]);
});

test('explicit legacy-image sync preserves IDs and existing blobs; later consent cannot cover different missing images',async()=>{
  const {createImageOptionalSyncFile,applyWholeSyncFile,missingSyncImages}=await import('../src/utils/backupPayload.ts');
  const {saveBackupPayload,saveBackupOriginals}=await import('../src/utils/backupRepository.ts');
  const {readAppRecordSnapshot}=await import('../src/utils/appRecordStorage.ts');
  const {readUserEditGeneration}=await import('../src/utils/userEditGeneration.ts');
  const {wholeHash}=await import('../src/utils/wholeSyncDigest.ts');
  const {queueWholeReplacement}=await import('../src/utils/wholeSyncStorage.ts');
  const {queueLegacyImageSync,readLegacyImageSync}=await import('../src/utils/legacyImageSync.ts');
  const {withCoordinatedDataMutation}=await import('../src/utils/dataCoordination.ts');
  const connection={project:'https://legacy.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:'c'.repeat(36)};
  const before=await exportFileBackup(),snapshot=await readAppRecordSnapshot(db),generation=await readUserEditGeneration(db);
  const chosenData=JSON.parse(before.localStorage['quiz-make-app-data-v1']);chosenData.questions[0].question='cloud without image metadata';
  const chosen=await createImageOptionalSyncFile({...before,localStorage:{...before.localStorage,'quiz-make-app-data-v1':JSON.stringify(chosenData)}},[]);
  assert.equal(chosen.backupManifest.completeness,'partial');
  assert.equal((await applyWholeSyncFile(chosen,generation,()=>{})).ok,false,'ordinary partial imports stay blocked');
  const rows=[...snapshot.records.values()].filter(row=>row.raw!==null&&row.collection!=='questionImages').map(row=>({key:row.key,collection:row.collection,id:row.id,position:row.position,revision:0,raw:row.collection==='questions'?JSON.stringify(chosenData.questions.find(question=>question.id===row.id)):row.raw}));
  const body={format:'quiz-make-sync-originals-v1',schema:1,connection,side:'remote',revision:0,createdAt:stamp,records:rows,notes:[],nativeValues:{},images:[],pdfFiles:{},issues:[]};
  const local=await saveBackupPayload(before,'before-sync'),saved=await saveBackupPayload(chosen,'before-sync'),original=await saveBackupOriginals(JSON.stringify({...body,originalsDigest:await wholeHash(JSON.stringify(body))}));
  const tx=db.transaction('appRecordMeta','readwrite');tx.objectStore('appRecordMeta').put(connection,'recordSyncConnection');tx.objectStore('appRecordMeta').put({connection,choice:'remote',preferSelected:true},'wholeConflict');await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j;});
  const proof={backupId:local.id,raw:local.raw,commitId:snapshot.state.commitId,connection,selectedImages:{backupId:saved.id,raw:saved.raw,originalId:original.id,originalRaw:original.raw}};
  const finalize=target=>{queueWholeReplacement(target,rows,{version:1,connection,serverRevision:0,userGeneration:generation,digest:'0'.repeat(64)});queueLegacyImageSync(target,connection,missingSyncImages(chosen));};
  const apply=(file,previous,legacy)=>withCoordinatedDataMutation(['app','notes'],()=>applyWholeSyncFile(file,generation,finalize,false,previous,legacy),{requireCrossContext:true});
  const result=await apply(chosen,proof);assert.equal(result.ok,true,result.error);
  assert.equal((await storage.loadAppDataAsync()).questions[0].question,'cloud without image metadata');
  assert.deepEqual((await storage.loadAppDataAsync()).questions[0].questionImageIds,['i']);
  const retained=(await imageStorage.readQuestionImages('q',['i']))[0];assert.deepEqual(new Uint8Array(await retained.blob.arrayBuffer()),new Uint8Array(await image.blob.arrayBuffer()));
  const consent=await readLegacyImageSync(db,connection);assert.deepEqual(consent.images,[{id:'i',questionId:'q'}]);
  const again=await apply(chosen,undefined,consent);assert.equal(again.ok,true,again.error);
  const different=await createImageOptionalSyncFile({...chosen,localStorage:{...chosen.localStorage,'quiz-make-app-data-v1':JSON.stringify({...chosenData,questions:[{...chosenData.questions[0],questionImageIds:['new-missing-image']}]})}},[]);
  assert.equal((await apply(different,undefined,consent)).ok,false,'newly missing IDs require a fresh explicit choice');
  assert.deepEqual((await storage.loadAppDataAsync()).questions[0].questionImageIds,['i']);
});
