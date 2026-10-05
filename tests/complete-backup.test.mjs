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
  await assert.rejects(exportFileBackup(),/完全/);
  const partial=await exportFileBackup({recovery:true});assert.equal(partial.backupManifest.completeness,'partial');
  assert.equal((await validateFileBackup(partial)).ok,true);assert.equal((await restoreFileBackup(partial)).ok,false);
  assert.equal((await restoreFileBackup(original)).ok,false,'cannot discard current data without a complete recovery copy');
  await imageStorage.saveQuestionImage(image);
  for(const row of await listWholeRecovery())await deleteWholeRecovery(row.id);
  assert.deepEqual(await listWholeRecovery(),[]);
});
