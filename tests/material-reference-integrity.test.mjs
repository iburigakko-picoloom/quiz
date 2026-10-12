import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {incomingFixture,stamp} from './helpers/whole-incoming-fixture.mjs';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
globalThis.window={dispatchEvent(){}};Object.defineProperty(navigator,'locks',{value:{request:async(_name,_options,run)=>run()},configurable:true});
const storage=await import('../src/storage.ts'),db=await storage.openAppDb();after(()=>db.close());
const {assertMaterialIntegrity}=await import('../src/utils/syncDataIntegrity.ts');
const {buildWholeIncomingFile}=await import('../src/utils/wholeSyncIncoming.ts');
const {validateFileBackup}=await import('../src/utils/backupPayload.ts');
const {hydrateMaterialDownload}=await import('../src/utils/materialCloud.ts');
const {saveCategoryNoteRaw}=await import('../src/utils/noteStorage.ts');
const {persistLibraryDeletion}=await import('../src/utils/libraryDeletion.ts');
const {syncFailureReason}=await import('../src/utils/syncStatusReason.ts');
const ref={materialId:'pdf-0',pageId:'page-0'};
const target={id:'copy',folderId:'f',title:'Synthetic copy',source:'',createdAt:stamp,updatedAt:stamp};
function copied(f){
  f.data.problemSets.push(target);f.data.questions[0]={...f.data.questions[0],setId:'copy',materialReferences:[ref]};
  for(const row of f.rows)if(row.collection==='questions')row.raw=JSON.stringify(f.data.questions[0]);
  f.rows.push({key:'["problemSets","copy"]',collection:'problemSets',id:'copy',raw:JSON.stringify(target),position:1,revision:1});
  return f;
}
const receive=f=>buildWholeIncomingFile(db,f.rows,f.transport,async()=>{});
test('another live set owns a copied question material; out-of-order parent rows and retries preserve the exact reference',async()=>{
  const f=copied(await incomingFixture({count:1})),original=JSON.stringify(f.rows);f.rows.reverse();
  for(let i=0;i<2;i++){
    const file=await receive(f);assert.equal((await validateFileBackup(file)).ok,true);
    assert.deepEqual(JSON.parse(file.localStorage['quiz-make-app-data-v1']).questions[0].materialReferences,[ref]);
  }
  assert.equal(f.downloaded,1);assert.equal(JSON.stringify([...f.rows].reverse()),original);
});
test('a deleted material owner remains a failure; missing IDs are identified without body text',async()=>{
  const f=copied(await incomingFixture({count:1}));f.rows=f.rows.map(row=>row.collection==='problemSets'&&row.id==='s'?{...row,raw:null}:row);
  await assert.rejects(receive(f),e=>e.diagnostic.referenceIssues[0].reason==='missing_owner'&&e.diagnostic.referenceIssues[0].problemSetId==='s');assert.equal(f.downloaded,0);
  const missing=await incomingFixture({count:1,badRef:true});
  await assert.rejects(receive(missing),e=>{assert.equal(e.diagnostic.issueCount,1);assert.equal(e.diagnostic.referenceIssues[0].questionId,'q');assert.equal(e.diagnostic.referenceIssues[0].reason,'missing_material');assert.ok(!JSON.stringify(e.diagnostic).includes('Synthetic'));assert.match(syncFailureReason({code:e.code,diagnostic:e.diagnostic}),/復旧/);return true;});
});
test('a removed page, duplicate material ID across owners, and duplicate pages are never guessed',async()=>{
  const f=copied(await incomingFixture({count:1}));
  f.data.questions[0].materialReferences=[{...ref,pageId:'deleted-page'}];
  assert.throws(()=>assertMaterialIntegrity(f.payload,f.data,false),e=>e.diagnostic.referenceIssues[0].reason==='missing_page');
  f.data.questions[0].materialReferences=[ref];
  const idx=JSON.parse(f.payload.indexedDbNotes['quizMake:notes:s:__materials_v1']);
  f.payload.indexedDbNotes['quizMake:notes:copy:__materials_v1']=JSON.stringify({...idx,problemSetId:'copy'});
  f.payload.indexedDbNotes['quizMake:notes:copy:__material_pdf_pdf-0']=f.payload.indexedDbNotes['quizMake:notes:s:__material_pdf_pdf-0'];
  assert.throws(()=>assertMaterialIntegrity(f.payload,f.data,false),e=>e.diagnostic.referenceIssues[0].reason==='ambiguous_material');
  delete f.payload.indexedDbNotes['quizMake:notes:copy:__materials_v1'];idx.materials[0].pages.push(idx.materials[0].pages[0]);f.payload.indexedDbNotes['quizMake:notes:s:__materials_v1']=JSON.stringify(idx);
  assert.throws(()=>assertMaterialIntegrity(f.payload,f.data,false),e=>e.diagnostic.referenceIssues[0].reason==='invalid_index');
});
test('legacy localStorage material records and new IndexedDB records validate the same graph',async()=>{
  const f=copied(await incomingFixture({count:1}));assert.doesNotThrow(()=>assertMaterialIntegrity(f.payload,f.data,false));
  assert.doesNotThrow(()=>assertMaterialIntegrity({localStorage:f.payload.indexedDbNotes},f.data,false));
  assert.throws(()=>assertMaterialIntegrity({...f.payload,localStorage:{'quizMake:notes:s:__materials_v1':'{}'}},f.data,false),e=>e.diagnostic.referenceIssues[0].reason==='index_identity');
  assert.throws(()=>assertMaterialIntegrity({...f.payload,indexedDbNotes:{'quizMake:notes:wrong:__materials_v1':f.payload.indexedDbNotes['quizMake:notes:s:__materials_v1']}},f.data,false),e=>e.diagnostic.referenceIssues[0].reason==='index_identity');
});
test('reference diagnostics are bounded even when hundreds of old references are missing',async()=>{
  const f=await incomingFixture({count:1,badRef:true});f.data.questions=Array.from({length:349},(_,i)=>({...f.data.questions[0],id:`q${i}`}));
  assert.throws(()=>assertMaterialIntegrity(f.payload,f.data,false),e=>e.diagnostic.issueCount===349&&e.diagnostic.referenceIssues.length===10);
});
test('copy save checks durable notes under the deletion lock; a stale draft writes no records and remains retryable',async()=>{
  const f=await incomingFixture({count:1});assert.equal(await storage.saveAppDataAsync(f.data),true);
  const hydrated=await hydrateMaterialDownload(f.payload,f.transport);
  for(const [key,raw] of Object.entries(hydrated.indexedDbNotes))await saveCategoryNoteRaw(key,raw);
  const draft={...f.data,problemSets:[...f.data.problemSets,target],questions:[...f.data.questions,{...f.data.questions[0],id:'draft',setId:'copy',materialReferences:[ref]}]};
  const saved=await storage.saveAppDataResult(draft,{materialReferenceQuestionIds:['draft']});assert.equal(saved.ok,true);
  const blocked=await persistLibraryDeletion({buildPlan:current=>({nextData:current,problemSetIds:['s']})});assert.equal(blocked.reason,'referenced-material');
  assert.equal(await storage.saveAppDataAsync({...draft,questions:f.data.questions}),true);
  const deletion=await persistLibraryDeletion({buildPlan:current=>({nextData:{...current,problemSets:[target],questions:[]},problemSetIds:['s']})});assert.equal(deletion.ok,true);
  const before=await storage.loadAppDataAsync();
  const stale=await storage.saveAppDataResult({...before,questions:[draft.questions[1]]},{materialReferenceQuestionIds:['draft']});
  assert.equal(stale.ok,false);assert.equal(stale.failure.code,'invalid_data');assert.match(stale.failure.validationReason,/資料/);
  assert.deepEqual(await storage.loadAppDataAsync(),before);assert.deepEqual(draft.questions[1].materialReferences,[ref]);
  assert.deepEqual(await storage.saveAppDataResult({...before,questions:[draft.questions[1]]},{materialReferenceQuestionIds:['draft']}),stale);
});


const {planMissingMaterialRepair,repairMissingMaterialReferences}=await import('../src/utils/materialReferenceRepair.ts');
const {archiveSyncOriginals,validateSyncOriginalsFile}=await import('../src/utils/syncOriginalBackup.ts');
const {getSavedBackup}=await import('../src/utils/backupRepository.ts');
const {exportCategoryNotesRaw,replaceCategoryNotesRaw,loadCategoryNoteRaw}=await import('../src/utils/noteStorage.ts');
const recordStorage=await import('../src/utils/appRecordStorage.ts');
async function repairFixture(){
  const f=await incomingFixture({count:16});
  f.data.questions=Array.from({length:460},(_,i)=>({...f.data.questions[0],id:`repair-q${i}`,materialReferences:[ref]}));
  f.data.progress=[{questionId:f.data.questions[0].id,level:2,correctCount:5,incorrectCount:1,lastAnsweredAt:stamp}];
  f.payload.localStorage['quiz-make-app-data-v1']=JSON.stringify(f.data);
  f.rows=f.rows.filter(r=>r.collection!=='questions'&&r.collection!=='progress');
  for(const collection of ['questions','progress'])for(const [position,row] of f.data[collection].entries())f.rows.push({key:JSON.stringify([collection,row.id??row.questionId]),collection,id:row.id??row.questionId,raw:JSON.stringify(row),position,revision:1});
  const hydrated=await hydrateMaterialDownload(f.payload,f.transport);
  const notes={...hydrated.indexedDbNotes},idx=JSON.parse(notes['quizMake:notes:s:__materials_v1']);idx.materials.shift();notes['quizMake:notes:s:__materials_v1']=JSON.stringify(idx);delete notes['quizMake:notes:s:__material_pdf_pdf-0'];
  return {f,notes,local:{...f.payload,indexedDbNotes:notes}};
}
test('460 missing references are repaired by adding the exact cloud PDF; existing 15 PDFs and every learning row survive',async()=>{
  const {f,notes,local}=await repairFixture(),original=JSON.stringify(local);
  const plan=planMissingMaterialRepair(local,f.payload);assert.equal(Object.keys(plan).length,2);assert.equal(JSON.stringify(local),original);
  await replaceCategoryNotesRaw(notes);assert.equal(await storage.saveAppDataAsync(f.data),true);
  const snapshot=await recordStorage.readCurrentAppRecordSnapshot(db),rows=[...snapshot.records.values()].filter(r=>r.raw!==null).map(r=>({...r,revision:r.serverRevision}));
  const before=await storage.loadAppDataAsync(),connection={url:'https://synthetic.test',userId:f.transport.userId,syncId:'a'.repeat(36)};
  let saved;const media={download:async()=>assert.fail('no image read'),userId:f.transport.userId};
  const guards={assertCurrent:async()=>{},assertRemoteCurrent:async()=>{},archive:async()=>saved=await archiveSyncOriginals(db,connection,'local',rows,media,f.transport,async()=>{})};
  const count=f.downloaded;assert.equal(await repairMissingMaterialReferences(db,rows,f.rows,f.transport,guards),true);assert.equal(f.downloaded,count,'verified cached PDF reused');
  assert.deepEqual(await storage.loadAppDataAsync(),before);
  const after=await exportCategoryNotesRaw();for(const [key,raw] of Object.entries(notes))if(!key.endsWith(':__materials_v1'))assert.equal(after[key],raw);
  assert.doesNotThrow(()=>assertMaterialIntegrity({...local,indexedDbNotes:after},before,true));
  const archived=JSON.parse((await getSavedBackup(saved.id)).raw);assert.equal(await validateSyncOriginalsFile(archived),true);assert.deepEqual(Object.fromEntries(archived.notes.map(r=>[r.key,r.raw])),notes);
  const next=await recordStorage.readCurrentAppRecordSnapshot(db);assert.equal((await recordStorage.readAppOutbox(db)).filter(r=>r.id==='quizMake:notes:s:__material_pdf_pdf-0').length,1);
  assert.equal(await repairMissingMaterialReferences(db,[...next.records.values()].filter(r=>r.raw!==null).map(r=>({...r,revision:r.serverRevision})),f.rows,f.transport,guards),false);
});
test('unproven question, wrong page, live file collision and account owner mismatch cannot repair or overwrite data',async()=>{
  const {f,local}=await repairFixture();
  for(const change of [cloud=>{const app=JSON.parse(cloud.localStorage['quiz-make-app-data-v1']);app.questions[0].id='different';cloud.localStorage['quiz-make-app-data-v1']=JSON.stringify(app)},cloud=>{const idx=JSON.parse(cloud.indexedDbNotes['quizMake:notes:s:__materials_v1']);idx.materials[0].pages[0].id='wrong';cloud.indexedDbNotes['quizMake:notes:s:__materials_v1']=JSON.stringify(idx)}]){
    const cloud=structuredClone(f.payload);change(cloud);try{assert.equal(planMissingMaterialRepair(local,cloud),null)}catch(error){assert.equal(error.code,'material_reference')}
  }
  const collision=structuredClone(local);collision.indexedDbNotes['quizMake:notes:s:__material_pdf_pdf-0']=f.payload.indexedDbNotes['quizMake:notes:s:__material_pdf_pdf-0'];assert.equal(planMissingMaterialRepair(collision,f.payload),null);
  const additions=planMissingMaterialRepair(local,f.payload);await assert.rejects(hydrateMaterialDownload({version:1,updatedAt:stamp,localStorage:{},indexedDbNotes:additions},{...f.transport,userId:'22222222-2222-4222-8222-222222222222'}),e=>e.code==='permission_denied');
});
test('revision changes or failed original backup stop additive repair before any live record is written',async()=>{
  const {f,notes}=await repairFixture();await replaceCategoryNotesRaw(notes);assert.equal(await storage.saveAppDataAsync(f.data),true);
  const snapshot=await recordStorage.readCurrentAppRecordSnapshot(db),rows=[...snapshot.records.values()].filter(r=>r.raw!==null).map(r=>({...r,revision:r.serverRevision}));
  const before=JSON.stringify(await recordStorage.readAppOutbox(db));
  await assert.rejects(repairMissingMaterialReferences(db,rows,f.rows,f.transport,{assertCurrent:async()=>{},assertRemoteCurrent:async()=>{throw Error('remote_changed')},archive:async()=>assert.fail('no backup')}),/remote_changed/);
  await assert.rejects(repairMissingMaterialReferences(db,rows,f.rows,f.transport,{assertCurrent:async()=>{},assertRemoteCurrent:async()=>{},archive:async()=>{throw Error('backup failed')}}),/backup failed/);
  assert.deepEqual(await exportCategoryNotesRaw(),notes);assert.equal(JSON.stringify(await recordStorage.readAppOutbox(db)),before);
});


test('corrupt PDF and quota failure preserve the incomplete originals and atomic outbox on retry',async()=>{
  const {f,notes}=await repairFixture();await replaceCategoryNotesRaw(notes);assert.equal(await storage.saveAppDataAsync(f.data),true);
  const snapshot=await recordStorage.readCurrentAppRecordSnapshot(db),rows=[...snapshot.records.values()].filter(r=>r.raw!==null).map(r=>({...r,revision:r.serverRevision}));
  const before=JSON.stringify(await recordStorage.readAppOutbox(db)),app=await storage.loadAppDataAsync();
  const connection={project:'https://synthetic.test',userId:f.transport.userId,syncId:'a'.repeat(36)};
  const media={download:async()=>assert.fail('no image read'),userId:f.transport.userId};
  const guards={assertCurrent:async()=>{},assertRemoteCurrent:async()=>{},archive:()=>archiveSyncOriginals(db,connection,'local',rows,media,f.transport,async()=>{})};
  await assert.rejects(repairMissingMaterialReferences(db,rows,f.rows,{...f.transport,cacheScope:crypto.randomUUID(),download:async()=>new Uint8Array(40).fill(99)},guards),e=>e.code==='pdf_integrity');
  const {IDBObjectStore}=await import('fake-indexeddb'),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){if(this.name==='categoryNotes'&&key==='quizMake:notes:s:__material_pdf_pdf-0')throw new DOMException('synthetic quota','QuotaExceededError');return put.call(this,value,key)};
  try{await assert.rejects(repairMissingMaterialReferences(db,rows,f.rows,f.transport,guards),e=>e.name==='QuotaExceededError')}finally{IDBObjectStore.prototype.put=put}
  assert.deepEqual(await exportCategoryNotesRaw(),notes);assert.deepEqual(await storage.loadAppDataAsync(),app);assert.equal(JSON.stringify(await recordStorage.readAppOutbox(db)),before);
  assert.equal(await repairMissingMaterialReferences(db,rows,f.rows,f.transport,guards),true);
});
