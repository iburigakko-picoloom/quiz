import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) };
globalThis.window = { dispatchEvent() {} };
Object.defineProperty(navigator, 'locks', { value: { request: async (_name,_options,run) => run() }, configurable: true });
const { saveAppDataAsync, openAppDb, loadAppDataAsync } = await import('../src/storage.ts');
const { saveCategoryNoteRaw, loadCategoryNoteRaw, exportCategoryNotesRaw, deleteCategoryNotesForProblemSetIds } = await import('../src/utils/noteStorage.ts');
const { deleteMaterial, materialIndexKey, materialFileKey, loadMaterials, storeMaterialPdf } = await import('../src/utils/materialStorage.ts');
const { appRecordKey } = await import('../src/utils/appRecordStorage.ts');
const db = await openAppDb(); after(() => db.close());
const stamp='2026-10-19T00:00:00Z';
const data={version:1,folders:[{id:'f',name:'F',createdAt:stamp,updatedAt:stamp}],problemSets:['s','other'].map(id=>({id,folderId:'f',title:id,createdAt:stamp,updatedAt:stamp})),questions:[{id:'q',setId:'other',question:'Q',choices:['a','b','c','d'],answerIndex:0,answerText:'a',explanation:'',sourcePage:'',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,materialReferences:[{materialId:'pdf',pageId:'p'}]}],progress:[],answerLogs:[]};
const index={kind:'quiz-material-index',version:1,problemSetId:'s',updatedAt:stamp,materials:[{id:'pdf',title:'PDF',pages:[{id:'p',kind:'pdf',pdfPage:1}]},{id:'keep',title:'Keep',pages:[{id:'blank',kind:'blank'}]}]};
const fileKey=materialFileKey('s','pdf'),inkKey='quizMake:notes:s:__material_ink_pdf_p';
const ink=JSON.stringify({dataUrl:'data:image/png;base64,aW5r',updatedAt:stamp});
test('referenced PDFs are protected; scoped deletion rolls back on failure and writes sync tombstones on success',async()=>{
  assert.equal(await saveAppDataAsync(data),true);
  await saveCategoryNoteRaw(materialIndexKey('s'),JSON.stringify(index));
  await saveCategoryNoteRaw(fileKey,JSON.stringify({kind:'quiz-material-file',version:1,materialId:'pdf',dataUrl:'data:application/pdf;base64,cGRm',updatedAt:stamp}));
  await saveCategoryNoteRaw(inkKey,ink);
  await saveCategoryNoteRaw('quizMake:notes:s:__scratch_memo_v1',ink);
  await assert.rejects(deleteMaterial('s','pdf'),/other.*1問/);
  assert.equal((await loadMaterials('s')).materials.length,2);
  const unlinked={...data,questions:data.questions.map(q=>({...q,materialReferences:[]}))};
  assert.equal(await saveAppDataAsync(unlinked),true);
  const originalDelete=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(key){if(this.name==='categoryNotes'&&key===fileKey){this.transaction.abort();throw new Error('forced abort');}return originalDelete.call(this,key);};
  try { await assert.rejects(deleteMaterial('s','pdf')); } finally { IDBObjectStore.prototype.delete=originalDelete; }
  assert.equal((await loadMaterials('s')).materials.length,2);
  assert.ok(await loadCategoryNoteRaw(fileKey));assert.equal(await loadCategoryNoteRaw(inkKey),ink);
  const result=await deleteMaterial('s','pdf');assert.deepEqual(result.materials.map(m=>m.id),['keep']);
  assert.equal(await loadCategoryNoteRaw(fileKey),null);assert.equal(await loadCategoryNoteRaw(inkKey),null);
  const notes=await exportCategoryNotesRaw();assert.equal(notes[fileKey],undefined);assert.equal(notes[inkKey],undefined);assert.equal(notes['quizMake:notes:s:__scratch_memo_v1'],ink);
  const read=(store,key)=>new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  for(const key of [fileKey,inkKey]) assert.equal((await read('appOutbox',appRecordKey('indexedDbNotes',key))).raw,null);
  assert.equal((await loadAppDataAsync()).questions[0].question,'Q');
});

test('library deletion includes canonical-only, backup-only and local fallback notes, with durable tombstones',async()=>{
  const keys=['canonical','backup','fallback'].map(id=>`quizMake:notes:removed:${id}`);
  await saveCategoryNoteRaw(keys[0],ink);
  const tx=db.transaction(['categoryNotes','categoryNoteBackups'],'readwrite');
  tx.objectStore('categoryNotes').delete(keys[0]);
  tx.objectStore('categoryNoteBackups').put(ink,keys[1]);
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const {accountLocalStorage}=await import('../src/utils/accountStorage.ts');
  accountLocalStorage.setItem(keys[2],ink);
  assert.equal(await deleteCategoryNotesForProblemSetIds(['removed']),3);
  for(const key of keys){
    assert.equal(await loadCategoryNoteRaw(key),null);
    assert.equal(accountLocalStorage.getItem(key),null);
    const read=db.transaction(['appRecords','appOutbox']);
    const record=read.objectStore('appRecords').get(appRecordKey('indexedDbNotes',key));
    const pending=read.objectStore('appOutbox').get(appRecordKey('indexedDbNotes',key));
    await new Promise((resolve,reject)=>{read.oncomplete=resolve;read.onabort=()=>reject(read.error);});
    assert.equal(record.result.raw,null);assert.equal(pending.result.raw,null);
  }
  assert.equal((await exportCategoryNotesRaw())['quizMake:notes:s:__scratch_memo_v1'],ink);
});

test('material persistence accepts 2000 pages and rejects excess pages or bytes before reading a file',async()=>{
  const {writeMeta}=await import('../src/utils/blobVault.ts');await writeMeta(db,'deltaEnabled',true);
  const file=new File(['%PDF-1.4 synthetic'],'boundary.pdf',{type:'application/pdf'});
  await assert.rejects(storeMaterialPdf('s',file,2001),/2000ページ/);
  await assert.rejects(storeMaterialPdf('s',{size:100*1024*1024+1},1),/100MB/);
  const material=await storeMaterialPdf('s',file,2000);
  assert.equal(material.pages.length,2000);assert.equal(material.pages.at(-1).pdfPage,2000);
  const saved=JSON.parse(await loadCategoryNoteRaw(materialFileKey('s',material.id)));
  assert.equal(saved.dataUrl,'data:application/pdf;base64,'+Buffer.from('%PDF-1.4 synthetic').toString('base64'));
});
