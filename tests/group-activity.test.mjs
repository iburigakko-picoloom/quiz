import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { buildStudyActivities, publishStudyActivity } from '../src/utils/groupActivity.ts';
import { activityOutbox, drainActivityOutbox } from '../src/utils/groupActivityOutbox.ts';
import { questionRevision } from '../src/utils/studyPlans.ts';
globalThis.indexedDB=indexedDB;
function fixture(){
 const question={id:'q',setId:'copy',question:'private question text',choices:['a','b','c','d'],answerIndex:0,explanation:'private explanation',category:'',difficulty:'basic'};
 const revision=questionRevision(question);
 question.origin={setId:'source',publicationVersionId:'v1',logicalId:'logical',contentRevision:'rev',importedContent:revision};
 const set={id:'copy',sourceSetId:'source',sourceVersionId:'v1',sourceManifest:[{logicalId:'logical',contentRevision:'rev'}]};
 const logs=[1,2].map(i=>({id:'answer-'+i,questionId:'q',setId:'copy',questionRevision:revision,answeredAt:'2026-11-07T12:00:0'+i+'Z',selectedIndex:0,isCorrect:true}));
 return {data:{problemSets:[set],questions:[question],answerLogs:logs,progress:[]},result:{sessionAnswers:logs.map(log=>({answerLogId:log.id}))}};
}
test('finished session aggregates only saved imported answers, excludes edits and sends no answer contents',()=>{
 const {data,result}=fixture();const rows=buildStudyActivities(data,result);assert.equal(rows.length,1);assert.equal(rows[0].answered,1);
 assert.deepEqual(buildStudyActivities(data,{sessionAnswers:[...result.sessionAnswers].reverse()}),rows);
 assert.equal(rows[0].id.length,64);assert.equal(JSON.stringify(rows).includes('private'),false);assert.equal(JSON.stringify(rows).includes('selectedIndex'),false);
 assert.deepEqual(buildStudyActivities(data,{sessionAnswers:[{answerLogId:'unsaved'}]}),[]);
 data.questions[0].question='edited';assert.deepEqual(buildStudyActivities(data,result),[]);
});
test('OFF and pre-consent activity never send counts; enabled requests are generation-bound',async()=>{
 const {data,result}=fixture(),row=buildStudyActivities(data,result)[0],calls=[];
 await publishStudyActivity(row,async(name,args)=>{calls.push({name,args});return [];});assert.equal(calls.length,1);assert.deepEqual(Object.keys(calls[0].args),['p_set_id']);
 calls.length=0;await publishStudyActivity(row,async(name,args)=>{calls.push({name,args});return [{group_id:'g',generation:'gen',enabled_at:'2026-11-07T13:00:00Z'}];});assert.equal(calls.length,1);
 calls.length=0;await publishStudyActivity(row,async(name,args)=>{calls.push({name,args});return name.endsWith('destinations')?[{group_id:'g',generation:'gen',enabled_at:'2026-11-07T11:00:00Z'}]:true;});assert.equal(calls.length,2);assert.equal(calls[1].args.p_generation,'gen');
});
test('durable account-isolated outbox retains network failures and retries with stable IDs',async()=>{
 const a={project:'https://example.test',userId:'a'},b={...a,userId:'b'},row=buildStudyActivities(...Object.values(fixture()))[0];
 const box=activityOutbox(a);await box.put([row]);await box.put([row]);assert.equal((await box.list()).length,1);assert.deepEqual(await activityOutbox(b).list(),[]);
 await assert.rejects(drainActivityOutbox(a,async()=>{throw new Error('offline');}),/offline/);assert.equal((await box.list()).length,1);
 let sent;await drainActivityOutbox(a,async value=>{sent=value;});assert.deepEqual(sent,row);assert.deepEqual(await box.list(),[]);
});

test('an event queued during an in-flight request is drained before completion', async()=>{
 const identity={project:'https://example.test',userId:'concurrent'},box=activityOutbox(identity),row=buildStudyActivities(...Object.values(fixture()))[0];
 await box.put([row]);let release,entered;const started=new Promise(r=>{entered=r;});const blocked=new Promise(r=>{release=r;});const sent=[];
 const work=drainActivityOutbox(identity,async event=>{sent.push(event.id);if(sent.length===1){entered();await blocked;}});
 await started;await box.put([{...row,id:'b'.repeat(64)}]);const joined=drainActivityOutbox(identity,async()=>{throw new Error('second sender must not run');});release();
 await Promise.all([work,joined]);assert.equal(sent.length,2);assert.deepEqual(await box.list(),[]);
});
