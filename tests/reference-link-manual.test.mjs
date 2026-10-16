import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReferenceLinks } from '../src/utils/referenceLinking.ts';

const first={materialId:'old',pageId:'old-page'},extra={materialId:'new',pageId:'new-page'};
const data={questions:[{id:'q',setId:'s',question:'unchanged',sourcePage:'',materialReferences:[first]}],progress:[{questionId:'q',correctCount:3}],answerLogs:[{id:'answer'}]};
const link={questionId:'q',sourcePage:'',reference:extra,append:true};
test('manual selection adds to existing references without changing answers or question content',()=>{
  const result=applyReferenceLinks(data,'s',[link],'now');
  assert.deepEqual(result.questions[0].materialReferences,[first,extra]);
  assert.equal(result.questions[0].question,'unchanged');
  assert.equal(result.progress,data.progress);assert.equal(result.answerLogs,data.answerLogs);
  assert.deepEqual(data.questions[0].materialReferences,[first]);
  assert.deepEqual(applyReferenceLinks(result,'s',[link],'later').questions[0].materialReferences,[first,extra]);
});
test('manual registration rejects stale sources, wrong sets, duplicates and excessive references atomically',()=>{
  for(const links of [[{...link,sourcePage:'changed'}],[link,link],[{...link,questionId:'missing'}]])assert.throws(()=>applyReferenceLinks(data,'s',links,'now'));
  assert.throws(()=>applyReferenceLinks(data,'other',[link],'now'));
  assert.throws(()=>applyReferenceLinks(data,'s',[{...link,append:false}],'now'));
  const full={...data,questions:[{...data.questions[0],materialReferences:Array.from({length:100},(_,i)=>({materialId:'old',pageId:String(i)}))}]};
  assert.throws(()=>applyReferenceLinks(full,'s',[link],'now'),/100/);
  assert.equal(full.questions[0].materialReferences.length,100);
});
