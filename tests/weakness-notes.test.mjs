import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNotes, makeExplanationRequest, explanationPrompt, rememberExplanationRequest, readExplanationBatch, applyQuestionExplanations, finishExplanationBatch, readWeaknessNotes, changeWeaknessNotes, NOTES_KEY } from '../src/utils/weaknessNotes.ts';
const storage = new Map();
globalThis.localStorage = {getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
globalThis.window = new EventTarget();
const q={id:'q1',setId:'s1',question:'Choose',choices:['A','B','C','D'],answerIndex:0,explanation:'通常解説は残す',detailedExplanation:'旧解説',detailedAnswer:{body:'保存済み解説',imageIds:['legacy-image'],updatedAt:'old'},updatedAt:'old'};
const data={version:1,folders:[],problemSets:[{id:'s1',title:'問題セット'}],questions:[q],progress:[{questionId:'q1',correctCount:5}],answerLogs:[{id:'log'}]};
const memo={id:'m1',title:'疑問',body:'なぜA？',questionId:'q1'};
function setup(){storage.clear();storage.set(NOTES_KEY,JSON.stringify([memo]));const request=makeExplanationRequest([memo],data);rememberExplanationRequest(request);const text=JSON.stringify({version:1,requestId:request.id,explanations:[{targetId:'question:q1',body:'追加の解説'}]});return {request,text,batch:readExplanationBatch(text)};}
test('legacy free notes survive and malformed notes fail closed',()=>{assert.deepEqual(parseNotes(JSON.stringify([{id:'old',title:'元のメモ',body:'本文'}])),[{id:'old',title:'元のメモ',body:'本文'}]);assert.throws(()=>parseNotes('{}'));assert.throws(()=>parseNotes('[{"id":1}]'));});
test('question updates append without changing answers, ordinary explanation, images or progress',()=>{const {batch}=setup();const next=applyQuestionExplanations(data,batch);assert.equal(next.questions[0].explanation,q.explanation);assert.deepEqual(next.questions[0].choices,q.choices);assert.deepEqual(next.questions[0].detailedAnswer.imageIds,['legacy-image']);assert.ok(next.questions[0].detailedAnswer.body.startsWith('保存済み解説'));assert.ok(next.questions[0].detailedAnswer.body.includes('追加の解説'));assert.deepEqual(next.progress,data.progress);assert.deepEqual(next.answerLogs,data.answerLogs);assert.equal(applyQuestionExplanations(next,batch).questions[0].detailedAnswer.body,next.questions[0].detailedAnswer.body);});
test('unknown request, wrong target, duplicates and empty answers are rejected',()=>{const {request}=setup();const val={version:1,requestId:request.id,explanations:[{targetId:'question:q1',body:'ok'}]};for(const bad of [{...val,requestId:'unknown'},{...val,explanations:[{targetId:'question:q2',body:'ok'}]},{...val,explanations:[...val.explanations,...val.explanations]},{...val,explanations:[{targetId:'question:q1',body:''}]}])assert.throws(()=>readExplanationBatch(JSON.stringify(bad)));});
test('changed or deleted questions abort the whole batch',()=>{const {batch}=setup();assert.throws(()=>applyQuestionExplanations({...data,questions:[]},batch));assert.throws(()=>applyQuestionExplanations({...data,questions:[{...q,question:'edited'}]},batch));assert.throws(()=>applyQuestionExplanations({...data,questions:[{...q,answerIndex:1}]},batch));});
test('later memo edits stay unresolved after importing the old request',()=>{const {batch}=setup();changeWeaknessNotes(ns=>ns.map(n=>({...n,body:'追加の疑問'})));finishExplanationBatch(batch);const n=readWeaknessNotes()[0];assert.equal(n.body,'追加の疑問');assert.equal(n.resolvedBody,'なぜA？');});
test('free memo explanations append and remain idempotent',()=>{storage.clear();const n={id:'free',title:'メモ',body:'疑問',explanation:'以前の解説'};storage.set(NOTES_KEY,JSON.stringify([n]));const request=makeExplanationRequest([n],data);rememberExplanationRequest(request);const batch=readExplanationBatch(JSON.stringify({version:1,requestId:request.id,explanations:[{targetId:'memo:free',body:'新しい説明'}]}));finishExplanationBatch(batch);const saved=readWeaknessNotes()[0];assert.ok(saved.explanation.startsWith('以前の解説'));finishExplanationBatch(batch);assert.deepEqual(readWeaknessNotes()[0],saved);});
test('prompt conditions and problem identifiers are preserved',()=>{const {request}=setup();const p=explanationPrompt(request,{tables:true,images:true,examples:true});assert.ok(p.includes(request.id));assert.ok(p.includes('question:q1'));assert.ok(p.includes('なぜA？'));assert.ok(p.includes('通常解説は残す'));assert.ok(p.includes('Markdownの表'));assert.ok(p.includes('捏造しない'));});
test('normal answer markup and swipe rail remain separate from the new detail component',()=>{const s=readFileSync(new URL('../src/screens/QuizRunner.tsx',import.meta.url),'utf8');assert.match(s,/<ExplanationContent text=\{explanation\}/);assert.match(s,/<WeaknessDetail key=\{questionId\}/);assert.match(s,/handleDetailPointerMove/);assert.match(s,/handleNextWithDraftCheck/);assert.doesNotMatch(s,/handleClipboardRead|handleSaveDetail =/);});

test('one-shot explanation template imports with exact IDs and respects visual options',()=>{
  const {request}=setup();
  for(const enabled of [true,false]){
    const prompt=explanationPrompt(request,{tables:enabled,images:enabled,examples:enabled});
    assert.ok(prompt.includes('原則1回の回答で完成したJSON'));
    assert.ok(prompt.includes('今回の疑問だけに簡潔に'));
    assert.ok(prompt.includes(enabled?'Markdownの表':'表は不要'));
    assert.ok(prompt.includes(enabled?'JSONを省略しない':'画像は不要'));
    const example=prompt.split('\n').find(line=>line.startsWith('{"version"'));
    const batch=readExplanationBatch(example);
    assert.equal(batch.request.id,request.id);
    assert.deepEqual(batch.replies.map(r=>r.targetId),request.targets.map(t=>t.targetId));
    const reply=JSON.parse(example);
    reply.explanations[0].body='**重要語**\n\n|A|B|\n|---|---|\n|値|値|\n\n```flow\n条件 → 結果\n```';
    assert.equal(readExplanationBatch(JSON.stringify(reply)).replies[0].body,reply.explanations[0].body);
  }
});
