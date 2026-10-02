import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
const hook = registerHooks({ resolve(s,c,next) { return next(/^\.\.?\//.test(s) && !/\.[cm]?[jt]sx?$/.test(s) && c.parentURL?.endsWith('.ts') ? s+'.ts' : s,c); } });
const plans = await import('../src/utils/studyPlans.ts');
const { commonVersionProgress, parseGroupProgress } = await import('../src/utils/groupProgress.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const { recordAnswer } = await import('../src/utils/quiz.ts');
const { randomizeQuestionChoices } = await import('../src/utils/choiceRandomization.ts');
hook.deregister();
const timestamp = '2026-10-01T00:00:00.000Z';
const q = (id) => ({ id, setId:'set', question:'Q '+id, choices:['a','b','c','d'], answerIndex:0, answerText:'a', explanation:'', sourcePage:'', category:'未分類', difficulty:'basic', createdAt:timestamp,updatedAt:timestamp });
const data = (n=20) => ({ version:1, folders:[{ id:'folder',name:'English',createdAt:timestamp,updatedAt:timestamp }],problemSets:[{ id:'set',folderId:'folder',title:'English',source:'',createdAt:timestamp,updatedAt:timestamp }],questions:Array.from({length:n},(_,i)=>q('q'+i)),progress:[],answerLogs:[] });
const create = (d,kind='deadline') => ({ schema:1,id:'plan',title:'English',setId:'set',setTitle:'English',timeZone:'Asia/Tokyo',createdAt:timestamp,updatedAt:timestamp,targets:plans.snapshotTargets(d.questions,d.answerLogs),schedules:[{ effectiveDay:'2026-10-01',kind,deadline:'2026-10-04',weekdays:[0,1,2,3,4,5,6],holidays:[],dailyCounts:[5,5,5,5,5,5,5],paused:false }] });
const log = (question,id,at='2026-10-02T03:00:00.000Z',extra={}) => ({ id,questionId:question.id,setId:'set',folderId:'folder',selectedIndex:0,isCorrect:true,answeredAt:at,questionRevision:plans.questionRevision(question),...extra });
test('deadline allocation fixes the day goal from pre-day answers, ignores repetition, never extends expiry',()=>{
  const d=data(); const p=create(d); d.answerLogs.push(log(d.questions[0],'before','2026-10-01T03:00:00Z'));
  const daily=plans.makePlanDay(p,d.answerLogs,'2026-10-02'); assert.equal(daily.goal,7);
  d.answerLogs.push(log(d.questions[1],'one'),log(d.questions[1],'repeat'),log(d.questions[2],'two'));
  const s=plans.planStatus(p,d,daily,new Date('2026-10-02T03:00:00Z')); assert.equal(s.done,2); assert.equal(s.goal,7);assert.equal(s.answerCount,4);assert.equal(s.answered,3);
  assert.equal(plans.planStatus(p,d,daily,new Date('2026-10-05T00:00:00Z')).expired,true); assert.equal(p.schedules[0].deadline,'2026-10-04');
});
test('habit counts same-day distinct target review, and a rest day adds no catch-up',()=>{
  const d=data(); const p=create(d,'habit');p.schedules[0].holidays=['2026-10-01'];
  d.answerLogs=[log(d.questions[18],'first'),log(d.questions[18],'repeat'),log(d.questions[19],'review')];
  const daily=plans.makePlanDay(p,d.answerLogs,'2026-10-02');assert.equal(daily.goal,5);assert.equal(plans.planStatus(p,d,daily).done,2);
  assert.equal(plans.makePlanDay(p,d.answerLogs,'2026-10-03').goal,5);assert.equal(plans.makePlanDay(p,d.answerLogs,'2026-10-01').goal,0);
});
test('target versions and denominator survive edits, additions and missing sets',()=>{
  const d=data(3),p=create(d,'habit'); const day=plans.makePlanDay(p,[],'2026-10-02');
  d.questions[0].question='edited';d.questions.push(q('new'));d.questions=d.questions.filter(q=>q.id!=='q1');
  d.answerLogs=[log(d.questions[0],'changed')];const s=plans.planStatus(p,d,day);assert.equal(s.total,3);assert.equal(s.missing,2);assert.equal(s.done,0);assert.deepEqual(s.questions.map(q=>q.id),['q2']);
  assert.equal(p.targets[0].question.question,'Q q0');
});
test('several plans consume the same saved log while the global count deduplicates',()=>{
  const d=data(10),p=create(d,'habit'),p2={...create(d,'habit'),id:'second'};const day=plans.makePlanDay(p,[],'2026-10-02');
  d.answerLogs=[log(d.questions[0],'same'),log(d.questions[0],'repeat')];
  assert.equal(plans.planStatus(p,d,day).done,1);assert.equal(plans.planStatus(p2,d,{...day,planId:'second'}).done,1);
  assert.deepEqual(plans.aggregatePlanToday([{plan:p,daily:day},{plan:p2,daily:{...day,planId:'second'}}],d),{done:1,goal:5});assert.equal(d.answerLogs.length,2);
});
test('fixed IANA days handle travel, midnight, DST and calendar horizons',()=>{
  assert.equal(plans.studyDay('2026-10-01T15:00:00Z','Asia/Tokyo'),'2026-10-02');
  assert.equal(plans.studyDay('2026-03-08T06:59:00Z','America/New_York'),'2026-03-08');
  assert.equal(plans.studyDay('2026-03-08T07:01:00Z','America/New_York'),'2026-03-08');
  assert.equal(plans.nextDay('2026-12-31'),'2027-01-01');assert.equal(plans.validDay('2026-02-30'),false);
});
test('malformed, duplicate and mismatched plan versions fail closed on restore',()=>{
  const p=create(data());assert.deepEqual(plans.parseStudyPlan(JSON.stringify(p)),p);
  for(const changed of [{...p,timeZone:'invalid'}, {...p,targets:[p.targets[0],p.targets[0]]}, {...p,targets:[{...p.targets[0],revision:'fake'}]}, {...p,schedules:[{...p.schedules[0],dailyCounts:[-1]}]}])assert.throws(()=>plans.parseStudyPlan(JSON.stringify(changed)));
  assert.throws(()=>plans.parsePlanDay(JSON.stringify({schema:1,planId:'p',day:'2026-10-02',goal:2,targetIds:['q']})));
});
test('origin and old answer versions survive normalization; edited content does not become a new version answer',()=>{
  const d=data(1);const original=plans.questionRevision(d.questions[0]);d.questions[0].origin={setId:'shared',logicalId:'logical',publicationVersionId:'version',contentRevision:'hash',importedContent:original};d.questions[0].logicalId='logical';
  d.problemSets[0].sourceVersionId='version';d.problemSets[0].sourceSetId='shared';d.problemSets[0].sourceManifest=[{logicalId:'logical',contentRevision:'hash'}];
  d.answerLogs=[log(d.questions[0],'old'),log(d.questions[0],'repeat')];
  const normalized=normalizeAppData(d);assert.equal(normalized.ok,true);assert.deepEqual(commonVersionProgress(normalized.data,normalized.data.problemSets[0],'shared','version'),{answered:1,total:1});
  d.questions[0].question='my edit';const after=normalizeAppData(d);assert.equal(after.ok,true);assert.equal(after.data.answerLogs.length,2);assert.deepEqual(commonVersionProgress(after.data,after.data.problemSets[0],'shared','version'),{answered:0,total:1});
  assert.equal(commonVersionProgress(d,{...d.problemSets[0],sourceVersionId:undefined},'shared','version'),null);
});
test('unshared and pending group rows cannot be interpreted as zero-percent rows',()=>{
  const s={version_id:'v',own:{enabled:false,generation:null,copy_id:null,version_id:null},members:[{user_id:'u',display_name:'User',state:'not_shared',answered:null,total:null,reflected_at:null}]};assert.deepEqual(parseGroupProgress(s),s);
  assert.throws(()=>parseGroupProgress({...s,members:[{...s.members[0],answered:0,total:10}]}));
});
test('shuffled choices save the original session version, including retry and later edits',()=>{
  const d=data(1); const source={...d.questions[0],shuffleChoices:true,distractors:['extra']}; d.questions[0]=source;
  const p=create(d,'habit'); const presented=randomizeQuestionChoices(source,()=>0);
  assert.notEqual(plans.questionRevision(presented),plans.questionRevision(source));
  const result=recordAnswer(d,presented,presented.answerIndexes,false,'shuffled-log',source);
  assert.equal(result.isCorrect,true);assert.equal(result.data.answerLogs[0].questionRevision,plans.questionRevision(source));
  assert.deepEqual(result.data.answerLogs[0].presentedChoices,presented.choices);
  assert.equal(plans.targetLogs(p,result.data.answerLogs).length,1);
  assert.equal(recordAnswer(result.data,presented,presented.answerIndexes,false,'shuffled-log',source).data.answerLogs.length,1);
  const edited={...source,question:'changed after session start'};
  assert.notEqual(result.data.answerLogs[0].questionRevision,plans.questionRevision(edited));
});
