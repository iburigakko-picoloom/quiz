import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planGroupImport} from '../src/utils/groupImport.ts';
import {normalizeAppData} from '../src/utils/appDataValidation.ts';
const time='2026-10-11T00:00:00Z';
const data={version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]};
const shared=id=>({id,localSetId:id,ownerId:'owner',authorName:'Owner',title:id,description:'',source:'',subject:'',audience:'CBT',difficulty:'basic',creationMethod:'manual',visibility:'group',questionCount:1,addCount:0,publishedAt:time,updatedAt:time,versionId:'v1',questions:[{logicalId:id,contentRevision:'revision',question:'Q',choices:['A','B','C','D'],answerIndexes:[0],answerText:'A',explanation:'E',detailedExplanation:'',sourcePage:'',category:'C',difficulty:'basic'}]});
const a=shared('a'),b=shared('b');
const child={key:'group:child',id:'child',name:'子フォルダ',creatorName:'Owner',updatedAt:time,importCount:0,sets:[b],children:[]};
const folder={key:'group:root',id:'root',name:'共有フォルダ',creatorName:'Owner',updatedAt:time,importCount:0,sets:[a],children:[child]};
test('group folder copy retains child placement, private copies, and durable group provenance',()=>{
  const before=structuredClone(data),plan=planGroupImport(data,folder,[a,b],'g1',time);
  assert.deepEqual(data,before);assert.equal(plan.data.folders.length,2);assert.equal(plan.data.problemSets.length,2);
  const root=plan.data.folders.find(f=>!f.parentFolderId),localChild=plan.data.folders.find(f=>f.parentFolderId===root.id);
  assert.equal(root.sourceGroupId,'g1');assert.equal(root.sourceGroupFolderKey,folder.key);assert.equal(localChild.name,child.name);
  assert.equal(plan.data.problemSets.find(s=>s.sourceSetId==='b').folderId,localChild.id);
  assert.ok(plan.data.problemSets.every(s=>s.visibility==='private'));assert.ok(plan.data.progress.every(p=>p.answeredCount===0));
  const normalized=normalizeAppData(plan.data);assert.equal(normalized.ok,true);assert.equal(normalized.data.folders[0].sourceGroupId,'g1');
});
test('repeat imports preserve learning; edited copies and other groups are independent',()=>{
  const first=planGroupImport(data,folder,[a,b],'g1',time);first.data.progress[0].answeredCount=5;
  const again=planGroupImport(first.data,folder,[a,b],'g1',time);assert.equal(again.data.problemSets.length,2);assert.equal(again.data.progress[0].answeredCount,5);
  first.data.questions[0].question='Local edit';const edited=planGroupImport(first.data,folder,[a,b],'g1',time);assert.equal(edited.data.problemSets.length,3);assert.equal(edited.data.questions[0].question,'Local edit');
  const other=planGroupImport(again.data,folder,[a,b],'g2',time);assert.equal(other.data.folders.filter(f=>!f.parentFolderId).length,2);
});
test('one incomplete source aborts the whole plan without changing local data',()=>{
  const before=structuredClone(data);assert.throws(()=>planGroupImport(data,folder,[a,{...b,questions:[]}],'g1',time));assert.deepEqual(data,before);
});

test('nested group folders retain every level and repeat imports reuse the complete path',()=>{
  const c=shared('c');
  const nested={...folder,children:[{...child,children:[{...child,key:'group:grandchild',id:'grandchild',name:'孫フォルダ',sets:[c]}]}]};
  const first=planGroupImport(data,nested,[a,b,c],'g1',time);
  const root=first.data.folders.find(f=>!f.parentFolderId),localChild=first.data.folders.find(f=>f.parentFolderId===root.id);
  const grandchild=first.data.folders.find(f=>f.parentFolderId===localChild.id);
  assert.equal(grandchild.name,'孫フォルダ');
  assert.equal(first.data.problemSets.find(s=>s.sourceSetId==='c').folderId,grandchild.id);
  first.data.progress[2].answeredCount=7;
  const again=planGroupImport(first.data,nested,[a,b,c],'g1',time);
  assert.equal(again.data.folders.length,3);assert.equal(again.data.problemSets.length,3);assert.equal(again.data.progress[2].answeredCount,7);
});
