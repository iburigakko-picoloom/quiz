import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planPublicImport} from '../src/utils/publicImport.ts';
import {normalizeAppData} from '../src/utils/appDataValidation.ts';
import {questionRevision} from '../src/utils/studyPlans.ts';
import {uniquePublicSets,publicFilterArgs,initialPublicFilters} from '../src/utils/publicLibrary.ts';
const time='2026-10-08T00:00:00Z';
const data={version:1,folders:[{id:'existing',name:'Existing',createdAt:time,updatedAt:time}],problemSets:[],questions:[],progress:[],answerLogs:[]};
const set={id:'cloud',localSetId:'source',ownerId:'owner',authorName:'Author',title:'Published',description:'Description',subject:'Medicine',audience:'CBT',source:'',difficulty:'basic',creationMethod:'manual',visibility:'link',questionCount:1,addCount:0,importCount:0,standalonePublic:false,tags:['CBT'],publishedAt:time,updatedAt:time,versionId:'version',questions:[{logicalId:'logical',contentRevision:'revision',question:'Synthetic',choices:['A','B','C','D'],answerIndexes:[0],answerText:'A',explanation:'Explanation',detailedExplanation:'Details',sourcePage:'1',category:'Medicine',difficulty:'basic',distractors:['E'],shuffleChoices:false}]};
const folder={id:'folder',ownerId:'owner',name:'Public folder',description:'',category:'Medicine',tags:[],authorName:'Author',published:true,setCount:1,questionCount:1,importCount:0,updatedAt:time};
test('folder imports preserve hierarchy and origin, initialize independent learning, and survive normalization',()=>{
  const source=structuredClone(set),plan=planPublicImport(data,[{...set,memberPath:[{id:'child',name:'Child'}]}],{folder},time);
  const root=plan.data.folders.find(f=>f.id===plan.folderId),child=plan.data.folders.find(f=>f.parentFolderId===root.id);assert.equal(root.sourcePublicFolderId,folder.id);assert.equal(child.name,'Child');assert.equal(plan.data.problemSets[0].folderId,child.id);assert.equal(plan.data.problemSets[0].visibility,'private');assert.equal(plan.data.questions[0].origin.importedContent,questionRevision(plan.data.questions[0]));assert.equal(plan.data.progress[0].answeredCount,0);assert.deepEqual(set,source);
  const normalized=normalizeAppData(plan.data);assert.equal(normalized.ok,true);assert.equal(normalized.data.folders.find(f=>f.id===root.id).sourcePublicFolderId,folder.id);
});
test('repeat folder import reuses untouched copies; edited copies and their learning survive separately',()=>{
  const first=planPublicImport(data,[set],{folder},time),again=planPublicImport(first.data,[set],{folder},time);assert.equal(again.data.folders.length,first.data.folders.length);assert.equal(again.data.problemSets.length,1);assert.equal(again.imported[0].localId,first.imported[0].localId);
  first.data.questions[0].question='User edit';first.data.progress[0].answeredCount=8;const updated=planPublicImport(first.data,[set],{folder},time);assert.equal(updated.data.problemSets.length,2);assert.equal(updated.data.progress[0].answeredCount,8);assert.equal(updated.data.questions[0].question,'User edit');
});
test('single set import creates a requested folder and incomplete source fails without mutating either side',()=>{
  const old=structuredClone(data),plan=planPublicImport(data,[set],{newFolderName:'New'},time);assert.equal(plan.data.folders.at(-1).name,'New');assert.deepEqual(data,old);assert.throws(()=>planPublicImport(data,[{...set,questionCount:2}],{targetId:'existing'}),/確認/);assert.deepEqual(data,old);
});
test('search args and deduplication retain explicit type, range and updated sorting',()=>{
  assert.equal(uniquePublicSets([set,set]).length,1);assert.deepEqual(publicFilterArgs(' CBT ',{...initialPublicFilters,kind:'folder',minimum:100,maximum:300,sort:'updated'}),{p_query:'CBT',p_kind:'folder',p_category:'',p_min:100,p_max:300,p_sort:'updated',p_offset:0,p_limit:30});
});

test('imported folder origin metadata and learning remain intact through the normal record storage roundtrip',async()=>{
  const {IDBFactory,IDBKeyRange}=await import('fake-indexeddb');globalThis.IDBKeyRange=IDBKeyRange;globalThis.window={dispatchEvent(){}};
  const {upgradeAppRecordStores,saveAppRecords,readAppRecordSnapshot,materializeAppRecords}=await import('../src/utils/appRecordStorage.ts');
  const factory=new IDBFactory(),db=await new Promise((resolve,reject)=>{const req=factory.open('public-import',1);req.onupgradeneeded=()=>upgradeAppRecordStores(req.result);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  try{const plan=planPublicImport(data,[{...set,memberPath:[{id:'child',name:'Child'}]}],{folder},time);plan.data.progress[0].answeredCount=4;await saveAppRecords(db,plan.data,time);const loaded=materializeAppRecords(await readAppRecordSnapshot(db));assert.equal(loaded.folders.find(f=>f.id===plan.folderId).sourcePublicFolderOwnerId,'owner');assert.equal(loaded.folders.find(f=>f.parentFolderId===plan.folderId).sourcePublicChildId,'child');assert.equal(loaded.progress[0].answeredCount,4);assert.equal(loaded.questions[0].origin.publicationVersionId,'version');}finally{db.close();}
});
