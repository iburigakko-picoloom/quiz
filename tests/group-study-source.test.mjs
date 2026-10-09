import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {publicationSourceFromSnapshot,applyPublishedSource,groupStudyCandidates,groupStudySelection,publishedQuestionContent,publishedQuestionRevision} from '../src/utils/groupStudySource.ts';
import {importedLearning} from '../src/utils/groupLearning.ts';
import {commonVersionProgress} from '../src/utils/groupProgress.ts';
import {normalizeAppData} from '../src/utils/appDataValidation.ts';
import {prepareLocalPublication} from '../src/utils/publicationPayload.ts';
import {questionRevision} from '../src/utils/studyPlans.ts';
const time='2026-10-09T00:00:00.000Z';
function fixture(){
  const questions=Array.from({length:4},(_,i)=>({id:`q${i}`,setId:'original',logicalId:`logical${i}`,question:`Question ${i}`,choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'Explanation',sourcePage:'',category:'Medicine',difficulty:'basic',createdAt:time,updatedAt:time,...(i===0?{questionImageIds:['private-image']}:{} )}));
  const set={id:'original',folderId:'folder',title:'Original',source:'',audience:'CBT',createdAt:time,updatedAt:time};
  const data={version:1,folders:[{id:'folder',name:'My folder',createdAt:time,updatedAt:time}],problemSets:[set],questions,progress:questions.map((q,i)=>({questionId:q.id,answeredCount:i?1:0,correctCount:i?1:0,wrongCount:0,lastSelectedIndex:null,lastAnsweredAt:null,isReview:true,isAmbiguous:false,reviewLevel:i||null,isGraduated:i===3})),answerLogs:[{id:'log',setId:set.id,folderId:'folder',questionId:questions[1].id,questionRevision:questionRevision(questions[1]),selectedIndex:0,isCorrect:true,answeredAt:time}]};
  const shared={id:'published',ownerId:'owner',localSetId:set.id,versionId:'version1',visibility:'group',questions:questions.map(q=>({...q,logicalId:q.logicalId,answerIndexes:[0],questionImageIds:undefined})),questionCount:4};
  return {data,set,shared,result:{id:shared.id,visibility:'group',shareToken:'unused',versionId:shared.versionId}};
}
test('publication acknowledgement links the original without copying questions, progress, logs or import provenance; retries are idempotent',()=>{
  const {data,shared,result}=fixture();data.problemSets[0].sourceSetId='earlier-publication';data.problemSets[0].sourceVersionId='earlier-version';
  const source=publicationSourceFromSnapshot(shared,'owner','original',['group2','group1','group1']);
  const next=applyPublishedSource(data,'original',result,source,time);
  assert.equal(next.questions,data.questions);assert.equal(next.progress,data.progress);assert.equal(next.answerLogs,data.answerLogs);assert.equal(next.folders,data.folders);assert.equal(next.problemSets.length,1);
  assert.equal(next.problemSets[0].sourceSetId,'earlier-publication');assert.equal(next.problemSets[0].sourceVersionId,'earlier-version');assert.deepEqual(source.groupIds,['group1','group2']);
  assert.equal(applyPublishedSource(next,'original',result,source,'2027-01-01T00:00:00Z'),next);
  assert.deepEqual(normalizeAppData(JSON.parse(JSON.stringify(next))).data.problemSets[0].publicationSource,source);
  const outgoing=prepareLocalPublication({data:next,setId:'original',visibility:'group',groupIds:['group1'],authorName:'Owner'});
  assert.equal(JSON.stringify(outgoing).includes('publicationSource'),false);assert.equal(JSON.stringify(outgoing).includes('private-image'),false);assert.equal(JSON.stringify(outgoing).includes('answerLogs'),false);
});
test('owner can use the original and existing progress with no copy or automatic consent; legacy originals are derived from the authorized server snapshot',()=>{
  const {data,shared,result}=fixture();const next=applyPublishedSource(data,'original',result,undefined,time),before=JSON.stringify(next);
  const [source]=groupStudyCandidates(next,shared,'owner');assert.equal(source.id,'original');assert.equal(source.publicationSource.versionId,'version1');assert.equal(JSON.stringify(next),before);
  const aggregate=importedLearning(next,source,'published','version1',new Date(time));assert.deepEqual(aggregate.levels,[1,1,1,1]);assert.equal(aggregate.answered,1);assert.equal(aggregate.total,4);
  assert.deepEqual(commonVersionProgress(next,source,'published','version1'),{answered:1,total:4});
  assert.deepEqual(groupStudyCandidates(next,shared,'other-account'),[]);assert.deepEqual(groupStudyCandidates(next,{...shared,localSetId:'other-original'},'owner'),[]);
});
test('edits, removed questions and added questions never change the immutable denominator or overwrite learning history',()=>{
  const {data,shared,result}=fixture(),source=publicationSourceFromSnapshot(shared,'owner','original');const next=applyPublishedSource(data,'original',result,source,time);
  next.questions=next.questions.filter(q=>q.id!=='q2').map(q=>q.id==='q1'?{...q,question:'Changed'}:q);next.questions.push({...next.questions[0],id:'extra',logicalId:'extra'});
  const progress=JSON.stringify(next.progress),logs=JSON.stringify(next.answerLogs);const a=importedLearning(next,next.problemSets[0],'published','version1',new Date(time));
  assert.deepEqual(a.levels,[3,0,0,1]);assert.equal(a.total,4);assert.equal(a.answered,0);assert.equal(JSON.stringify(next.progress),progress);assert.equal(JSON.stringify(next.answerLogs),logs);
});
test('wrong owner, wrong local id, duplicate source identities, withdrawn and deleted originals fail without resurrection',()=>{
  const {data,shared,result}=fixture();assert.throws(()=>publicationSourceFromSnapshot(shared,'other','original'),/所有者/);assert.throws(()=>publicationSourceFromSnapshot(shared,'owner','missing'),/所有者/);
  assert.throws(()=>publicationSourceFromSnapshot({...shared,questions:[shared.questions[0],shared.questions[0]]},'owner','original'),/重複/);
  const source=publicationSourceFromSnapshot(shared,'owner','original'),next=applyPublishedSource(data,'original',result,source,time);next.problemSets=[{...next.problemSets[0],cloudSetId:undefined,publicationSource:undefined,visibility:'private'}];
  assert.deepEqual(groupStudyCandidates(next,shared,'owner'),[]);assert.throws(()=>applyPublishedSource({...data,problemSets:[]},'original',result,source,time),/削除/);
  assert.throws(()=>applyPublishedSource(data,'original',{...result,id:'other'},source,time),/公開ID/);
});
test('current owned server version replaces a stale result and ambiguous malformed local provenance is rejected',()=>{
  const {data,shared,result}=fixture();const current={...shared,versionId:'version2',questions:shared.questions.map(q=>({...q,question:q.question+' v2'}))};
  const source=publicationSourceFromSnapshot(current,'owner','original'),next=applyPublishedSource(data,'original',{...result,versionId:'version2'},source,time);
  assert.equal(next.problemSets[0].publicationSource.versionId,'version2');assert.equal(groupStudySelection(next,next.problemSets[0],'published','version1'),null);
  assert.deepEqual(importedLearning(next,next.problemSets[0],'published','version2').levels,[4,0,0,0]);
  for(const bad of [{...source,setId:'other'},{...source,groupIds:['group','group']},{...source,manifest:[source.manifest[0],source.manifest[0]]}])assert.equal(normalizeAppData({...next,problemSets:[{...next.problemSets[0],publicationSource:bad}]}).ok,false);
});
test('source revisions match platform SHA-256, ignore private images and retain changes to public question content',()=>{
  const {data,shared}=fixture();const q={...data.questions[0],question:'日本語と😀',explanation:'説明\n二行'};
  assert.equal(publishedQuestionRevision(q),createHash('sha256').update(publishedQuestionContent(q),'utf8').digest('hex'));
  assert.equal(publishedQuestionRevision(q),publishedQuestionRevision({...q,questionImageIds:['different-private-image']}));
  assert.notEqual(publishedQuestionRevision(q),publishedQuestionRevision({...q,question:q.question+'編集'}));
  assert.equal(publishedQuestionRevision(data.questions[0]),publishedQuestionRevision(shared.questions[0]));
});
test('large originals retain a small publication pointer and derive exact immutable progress from an authorized snapshot without a large sync record',()=>{
  const {data,shared,result}=fixture();
  data.questions=Array.from({length:5000},(_,i)=>({...data.questions[0],id:`large-${i}`,logicalId:`logical-large-${i}`,question:'長い問題文'.repeat(160)}));
  shared.questions=data.questions.map(q=>({...q,answerIndexes:[0]}));shared.questionCount=5000;
  const source=publicationSourceFromSnapshot(shared,'owner','original',['group1']);assert.equal(source.manifest,undefined);
  const next=applyPublishedSource(data,'original',result,source,time);assert.ok(new TextEncoder().encode(JSON.stringify(next.problemSets[0])).byteLength<1000);
  assert.equal(next.questions,data.questions);assert.deepEqual(normalizeAppData(next).data.problemSets[0].publicationSource,source);
  assert.equal(groupStudySelection(next,next.problemSets[0],'published','version1'),null);
  const [candidate]=groupStudyCandidates(next,shared,'owner');assert.equal(candidate.publicationSource.manifest.length,5000);
  assert.deepEqual(importedLearning(next,candidate,'published','version1',new Date(time)).levels,[5000,0,0,0]);
  assert.equal(next.problemSets[0].publicationSource.manifest,undefined);
});
