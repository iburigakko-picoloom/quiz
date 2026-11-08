import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { buildStudyActivities, publishStudyActivity } from '../src/utils/groupActivity.ts';
import { activityOutbox, drainActivityOutbox } from '../src/utils/groupActivityOutbox.ts';
import { questionRevision } from '../src/utils/studyPlans.ts';
import { manualActivityOutbox, drainManualActivities } from '../src/utils/groupManualActivityOutbox.ts';
import { parseActivityFeed } from '../src/utils/groupActivityFeed.ts';
import { VisibleStudyTimer } from '../src/utils/visibleStudyTimer.ts';
import { shouldTrackStudy, watchNativeStudyActivity } from '../src/utils/studyVisibility.ts';
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

test('manual activity is account isolated, survives offline retries and reports revoked consent', async()=>{
 const a={project:'https://example.test',userId:'manual-a'},b={...a,userId:'manual-b'};
 const row={id:'e1',groupId:'g',generation:'gen',title:'講義ノート',answered:12,minutes:25,finishedAt:'2026-11-08T00:00:00Z'};
 const box=manualActivityOutbox(a);await box.put(row);assert.deepEqual(await manualActivityOutbox(b).list(),[]);
 await assert.rejects(drainManualActivities(a,async()=>{throw new Error('offline');}),/offline/);assert.deepEqual(await box.list(),[{row,status:'pending'}]);
 await drainManualActivities(a,async event=>{assert.deepEqual(event,row);return false;});assert.deepEqual(await box.list(),[{row,status:'rejected'}]);
 await drainManualActivities(a,async()=>{throw new Error('revoked entries must not be resent');});await box.remove(row.id);assert.deepEqual(await box.list(),[]);
});

test('manual retry reuses the same event ID and drains concurrent additions',async()=>{
 const identity={project:'https://example.test',userId:'manual-concurrent'},box=manualActivityOutbox(identity);
 const row={id:'m1',groupId:'g',generation:'gen',title:'読書',answered:null,minutes:10,finishedAt:'2026-11-08T00:00:00Z'};
 await box.put(row);await assert.rejects(drainManualActivities(identity,async()=>{throw new Error('lost response');}));
 let release,entered;const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),sent=[];
 const work=drainManualActivities(identity,async event=>{sent.push(event.id);if(sent.length===1){entered();await blocked;}return true;});
 await started;await box.put({...row,id:'m2'});release();await work;assert.deepEqual(sent,['m1','m2']);assert.deepEqual(await box.list(),[]);
});

test('timeline accepts only valid session and explicitly entered manual activity',()=>{
 const base={id:'1',user_id:'u',display_name:'A',title:'学習',finished_at:'2026-11-08T00:00:00Z'};
 const session={...base,kind:'session',set_id:'set',answered:3,minutes:null,seconds:8};
 const manual={...base,id:'2',kind:'manual',set_id:null,answered:null,minutes:25,seconds:null};
 const feed={enabled:true,generation:'gen',time_enabled:true,time_generation:'time-gen',entries:[manual,session]};assert.deepEqual(parseActivityFeed(feed),feed);
 for(const invalid of [{...manual,set_id:'invented'}, {...manual,minutes:0}, {...manual,seconds:9}, {...session,minutes:8}, {...session,answered:0}, {...session,seconds:0}, {...manual,kind:'other'}]) assert.throws(()=>parseActivityFeed({...feed,entries:[invalid]}));
 assert.throws(()=>parseActivityFeed({...feed,entries:[manual,manual]}));assert.throws(()=>parseActivityFeed({...feed,generation:null}));
});

test('study time measures visible intervals by question and can resume a saved snapshot',()=>{
 let mono=0,wall=Date.parse('2026-11-08T00:00:00Z');const advance=ms=>{mono+=ms;wall+=ms;};
 const timer=new VisibleStudyTimer({},()=>mono,()=>wall);timer.setVisible(true);timer.setQuestion({id:'q1',setId:'s1'});advance(5000);timer.setVisible(false);advance(60000);timer.setVisible(true);advance(3000);timer.setQuestion({id:'q2',setId:'s2'});advance(4000);
 const first=timer.snapshot();assert.equal(first.q1.elapsedMs,8000);assert.equal(first.q2.elapsedMs,4000);assert.equal(first.q1.valid,true);
 const resumed=new VisibleStudyTimer(first,()=>mono,()=>wall);resumed.setVisible(true);resumed.setQuestion({id:'q2',setId:'s2'});advance(2000);assert.equal(resumed.stop().q2.elapsedMs,6000);
});

test('study time is marked unavailable on a backwards clock or a changed question owner',()=>{
 let mono=100,wall=Date.parse('2026-11-08T00:00:00Z');const timer=new VisibleStudyTimer({},()=>mono,()=>wall);
 timer.setVisible(true);timer.setQuestion({id:'q',setId:'s'});mono+=1000;wall-=1000;assert.equal(timer.snapshot().q.valid,false);
 timer.setQuestion({id:'q',setId:'other'});assert.equal(timer.snapshot().q.valid,false);
});

test('clock regression across questions invalidates all measured intervals, including after restore',()=>{
 let mono=0,wall=Date.parse('2026-11-08T00:00:00Z');const timer=new VisibleStudyTimer({},()=>mono,()=>wall);timer.setVisible(true);timer.setQuestion({id:'a',setId:'s'});mono+=5000;wall+=5000;timer.setQuestion({id:'b',setId:'s'});mono+=1000;wall-=2000;
 const snapshot=timer.snapshot();assert.equal(snapshot.a.valid,false);assert.equal(snapshot.b.valid,false);
 const restored=new VisibleStudyTimer(snapshot,()=>mono,()=>wall);restored.setVisible(true);restored.setQuestion({id:'c',setId:'s'});mono+=1000;wall+=1000;assert.equal(restored.snapshot().c.valid,false);
 assert.deepEqual(new VisibleStudyTimer({bad:null},()=>mono,()=>wall).snapshot(),{});
});

test('monotonic clock regression invalidates previously measured questions',()=>{
 let mono=100,wall=Date.parse('2026-11-08T00:00:00Z');const timer=new VisibleStudyTimer({},()=>mono,()=>wall);timer.setVisible(true);timer.setQuestion({id:'a',setId:'s'});mono+=1000;wall+=1000;timer.setQuestion({id:'b',setId:'s'});mono-=100;wall+=100;const snapshot=timer.snapshot();assert.equal(snapshot.a.valid,false);assert.equal(snapshot.b.valid,false);
});

test('background, native inactivity and account fencing pause measurement',()=>{
 assert.equal(shouldTrackStudy('visible',true,false),true);assert.equal(shouldTrackStudy('hidden',true,false),false);assert.equal(shouldTrackStudy('visible',false,false),false);assert.equal(shouldTrackStudy('visible',true,true),false);
});

test('a late native state read cannot undo a newer background event',async()=>{
 let emit,resolveState,removed=false;const values=[];
 const app={addListener:async(_name,callback)=>{emit=callback;return {remove:async()=>{removed=true;}};},getState:()=>new Promise(resolve=>{resolveState=resolve;})};
 const stop=watchNativeStudyActivity(app,value=>values.push(value));await new Promise(resolve=>setImmediate(resolve));emit({isActive:false});resolveState({isActive:true});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(values,[false]);stop();await new Promise(resolve=>setImmediate(resolve));assert.equal(removed,true);
});

test('a native listener created after unmount is removed and cannot update',async()=>{
 let finish,removed=false;const values=[];const app={addListener:()=>new Promise(resolve=>{finish=resolve;}),getState:async()=>({isActive:true})};
 const stop=watchNativeStudyActivity(app,value=>values.push(value));stop();finish({remove:async()=>{removed=true;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(removed,true);assert.deepEqual(values,[]);
});

test('session duration uses only measured eligible questions and freezes the first queued version',async()=>{
 const {data,result}=fixture(),timing={q:{setId:'copy',startedAt:'2026-11-07T11:59:50.000Z',finishedAt:'2026-11-07T12:00:10.000Z',elapsedMs:12500,valid:true}};
 const [withTime]=buildStudyActivities(data,{...result,studyTime:timing});assert.deepEqual(withTime.duration,{seconds:12,startedAt:timing.q.startedAt,finishedAt:timing.q.finishedAt});
 assert.equal(buildStudyActivities(data,{...result,studyTime:{q:{...timing.q,valid:false}}})[0].duration,undefined);
 assert.equal(buildStudyActivities(data,result)[0].duration,undefined);
 const identity={project:'https://example.test',userId:'frozen-duration'},box=activityOutbox(identity);await box.put([withTime,withTime]);await box.put([{...withTime,duration:undefined}]);assert.equal((await box.list()).length,1);assert.deepEqual((await box.list())[0].duration,withTime.duration);
 await box.remove(withTime.id);
});

test('duration is never sent without explicit prior time consent for that group',async()=>{
 const {data,result}=fixture(),studyTime={q:{setId:'copy',startedAt:'2026-11-07T11:59:50.000Z',finishedAt:'2026-11-07T12:00:10.000Z',elapsedMs:12500,valid:true}};
 const [row]=buildStudyActivities(data,{...result,studyTime}),calls=[];
 const destination={group_id:'g',generation:'gen',enabled_at:'2026-11-07T11:00:00Z',time_generation:null,time_enabled_at:null};
 const invoke=async(name,args)=>{calls.push({name,args});return name.includes('destinations')?[destination]:true;};
 await publishStudyActivity(row,invoke);assert.equal(calls[0].name,'quiz_group_activity_destinations_v2');assert.equal(calls[1].name,'quiz_group_activity_publish');assert.equal('p_elapsed_seconds' in calls[1].args,false);
 calls.length=0;destination.time_generation='time-gen';destination.time_enabled_at='2026-11-07T12:00:00Z';await publishStudyActivity(row,invoke);assert.equal(calls[1].name,'quiz_group_activity_publish');
 calls.length=0;destination.time_enabled_at='2026-11-07T11:00:00Z';await publishStudyActivity(row,invoke);assert.equal(calls[1].name,'quiz_group_activity_publish_v2');assert.equal(calls[1].args.p_elapsed_seconds,12);assert.equal(calls[1].args.p_time_generation,'time-gen');assert.equal(JSON.stringify(calls[1].args).includes('private question'),false);
 calls.length=0;destination.time_enabled_at=null;await assert.rejects(publishStudyActivity(row,invoke),/共有設定/);assert.equal(calls.length,1);
});
