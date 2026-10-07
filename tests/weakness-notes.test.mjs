import test, { after } from 'node:test';
import { createServer } from 'vite';
const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
after(() => vite.close());

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { deleteWeaknessNote, removeOrphanWeaknessNotes, unexplainedNotes, parseNotes, makeExplanationRequest, explanationPrompt, rememberExplanationRequest, readExplanationBatch, applyQuestionExplanations, finishExplanationBatch, readWeaknessNotes, changeWeaknessNotes, NOTES_KEY } = await vite.ssrLoadModule('/src/utils/weaknessNotes.ts');
const coordination = await vite.ssrLoadModule('/src/utils/dataCoordination.ts');
const storage = new Map();
globalThis.localStorage = {getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
globalThis.window = new EventTarget();
const q={id:'q1',setId:'s1',question:'Choose',choices:['A','B','C','D'],answerIndex:0,explanation:'通常解説は残す',detailedExplanation:'旧解説',detailedAnswer:{body:'保存済み解説',imageIds:['legacy-image'],updatedAt:'old'},updatedAt:'old'};
const data={version:1,folders:[],problemSets:[{id:'s1',title:'問題セット'}],questions:[q],progress:[{questionId:'q1',correctCount:5}],answerLogs:[{id:'log'}]};
const memo={id:'m1',title:'疑問',body:'なぜA？',questionId:'q1'};

test('tablet copy starts in the tap, waits for durable preparation and retains exact request text for permission retry',async()=>{
  const {copyBrowserText,ClipboardCopyError}=await vite.ssrLoadModule('/src/utils/clipboardCopy.ts');
  const keys=['navigator','document','HTMLElement','ClipboardItem'],originals=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  let copyAllowed=false,legacyCalls=0,modernCalls=0,written='',focusedRestored=0,removed=0;
  class Element{focus(options){assert.equal(options.preventScroll,true);focusedRestored++}}
  class Item{constructor(data){this.data=data}}
  const focused=new Element();
  const doc={activeElement:focused,getSelection:()=>null,body:{appendChild(){}},createElement:()=>({style:{},value:'',setAttribute(){},focus(options){assert.equal(options.preventScroll,true)},select(){},setSelectionRange(){},remove(){removed++}}),execCommand:()=>{legacyCalls++;return copyAllowed}};
  const nav={clipboard:{async write(items){modernCalls++;const blob=await items[0].data['text/plain'];written=await blob.text()},async writeText(){assert.fail('prepared copy must not wait before using the tap')}}};
  [nav,doc,Element,Item].forEach((value,index)=>Object.defineProperty(globalThis,keys[index],{configurable:true,value}));
  try{
    let saved;const ready=new Promise(resolve=>{saved=resolve});
    const pending=copyBrowserText(ready);
    assert.equal(modernCalls,1,'clipboard request starts synchronously in the click');assert.equal(written,'');
    const text='requestId: same-request\n疑問「なぜ？」\n**重要語**';saved(text);await pending;assert.equal(written,text);assert.equal(legacyCalls,0);
    nav.clipboard.write=async()=>{throw new DOMException('private browser permission detail','NotAllowedError')};
    await assert.rejects(copyBrowserText(Promise.resolve(text)),error=>error instanceof ClipboardCopyError&&!error.message.includes('private'));
    const before=legacyCalls;copyAllowed=true;const retry=copyBrowserText(text);assert.equal(legacyCalls,before+1,'retry uses the fresh tap synchronously');await retry;
    assert.equal(focusedRestored,removed,'temporary selection is removed and focus restored');
    nav.clipboard.write=async items=>{await items[0].data['text/plain']};
    let rejectSave;const failed=new Promise((_,reject)=>{rejectSave=reject});const copying=copyBrowserText(failed);const rejected=assert.rejects(copying,/cannot save request/);rejectSave(new Error('cannot save request'));await rejected;
  }finally{keys.forEach((key,i)=>{if(originals[i])Object.defineProperty(globalThis,key,originals[i]);else delete globalThis[key]});}
});

test('memo keyboard holds the reading frame, allows deliberate scrolling and restores the session on exit',async()=>{
  const {lockMemoKeyboard,memoDockTop}=await vite.ssrLoadModule('/src/utils/memoKeyboard.ts');
  const keys=['window','document','navigator','requestAnimationFrame','cancelAnimationFrame'];
  const originals=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const style=()=>{const values=new Map();return{getPropertyValue:key=>values.get(key)??'',setProperty:(key,value)=>values.set(key,value),removeProperty:key=>values.delete(key)}};
  const classes=new Set(),root={style:style(),classList:{contains:key=>classes.has(key),add:key=>classes.add(key),remove:key=>classes.delete(key)}};
  const keyboard=Object.assign(new EventTarget(),{overlaysContent:false,boundingRect:{height:0,top:800}});
  const viewport=Object.assign(new EventTarget(),{height:800,offsetTop:0,scale:1});
  const win=Object.assign(new EventTarget(),{innerHeight:800,visualViewport:viewport,scrollX:0,scrollY:0,scrollTo(x,y){this.scrollX=x;this.scrollY=y}});
  const doc=Object.assign(new EventTarget(),{documentElement:root});
  const frames=new Map();let next=0;
  const sheet={style:style(),dataset:{},getBoundingClientRect:()=>({top:140,height:600})};
  const parent={scrollHeight:1000,clientHeight:500,scrollWidth:300,clientWidth:300,scrollTop:12,scrollLeft:0,parentElement:null};
  const anchor={parentElement:parent,closest:()=>sheet};
  const values=[win,doc,{virtualKeyboard:keyboard},run=>{frames.set(++next,run);return next},id=>frames.delete(id)];
  keys.forEach((key,i)=>Object.defineProperty(globalThis,key,{configurable:true,value:values[i]}));
  const drain=()=>{for(const [id,run] of [...frames]){frames.delete(id);run()}};
  let release;
  try{
    root.style.setProperty('--memo-layout-height','previous-height');
    const visible=[];release=lockMemoKeyboard(anchor,value=>visible.push(value));drain();
    assert.equal(keyboard.overlaysContent,true);assert.equal(root.style.getPropertyValue('--memo-layout-height'),'800px');
    assert.equal(sheet.style.getPropertyValue('--memo-sheet-top'),'140px');assert.equal(sheet.style.getPropertyValue('--memo-sheet-height'),'600px');
    keyboard.boundingRect={height:300,top:500};viewport.height=500;win.innerHeight=500;parent.scrollTop=140;
    keyboard.dispatchEvent(new Event('geometrychange'));drain();
    assert.equal(visible.at(-1),500);assert.equal(parent.scrollTop,12);assert.equal(root.style.getPropertyValue('--memo-layout-height'),'800px');
    assert.equal(memoDockTop(670,164,visible.at(-1)),328);
    doc.dispatchEvent(new Event('touchmove'));parent.scrollTop=90;viewport.dispatchEvent(new Event('scroll'));drain();assert.equal(parent.scrollTop,90);
    release();release();assert.equal(keyboard.overlaysContent,false);assert.equal(root.style.getPropertyValue('--memo-layout-height'),'previous-height');assert.equal(classes.size,0);
    assert.equal(sheet.style.getPropertyValue('--memo-sheet-top'),'');assert.equal('memoKeyboardAnchor' in sheet.dataset,false);
    const count=visible.length;keyboard.dispatchEvent(new Event('geometrychange'));drain();assert.equal(visible.length,count);
  }finally{release?.();keys.forEach((key,i)=>{if(originals[i])Object.defineProperty(globalThis,key,originals[i]);else delete globalThis[key]});}
});

test('question creation uses only answered memos with a remaining explanation', async()=>{
  const { hasAnsweredMemo } = await vite.ssrLoadModule('/src/utils/weaknessNotes.ts');
  const answered={...memo,resolvedBody:memo.body};
  assert.equal(hasAnsweredMemo(answered,data),true);
  for(const item of [memo,{...answered,draft:true},{...answered,body:'追加の疑問'},{...answered,questionId:'deleted'}])assert.equal(hasAnsweredMemo(item,data),false);
  assert.equal(hasAnsweredMemo(answered,{...data,questions:[{...q,detailedExplanation:'',detailedAnswer:{body:'<!-- marker -->',imageIds:[]}}]}),false);
});
test('second and third memos delete independently without deleting a concurrently edited memo',async()=>{
  storage.clear();coordination.resetDataCoordinationForTests();
  const second={...memo,id:'m2',body:'2つ目'},third={...memo,id:'m3',body:'3つ目'};
  storage.set(NOTES_KEY,JSON.stringify([memo,second,third]));
  await deleteWeaknessNote(second);
  assert.deepEqual(readWeaknessNotes(),[memo,third]);
  await deleteWeaknessNote(third);
  assert.deepEqual(readWeaknessNotes(),[memo]);
  await changeWeaknessNotes(notes=>notes.map(n=>({...n,body:'更新した疑問'})));
  await assert.rejects(()=>deleteWeaknessNote(memo),/更新されています/);
  assert.equal(readWeaknessNotes()[0].body,'更新した疑問');
});
test('batch copy includes unanswered saved memos even with existing explanations or images', () => {
  const qs = [{...q,id:'empty',detailedAnswer:undefined,detailedExplanation:'<!-- marker -->'}, q,
    {...q,id:'image',detailedAnswer:{body:'',imageIds:['image']}},
    {...q,id:'other',setId:'s2',detailedAnswer:undefined,detailedExplanation:''}];
  const memos = ['empty','q1','image','other','deleted'].map(id=>({...memo,id,questionId:id}));
  memos.push({...memo,id:'draft',questionId:'empty',draft:true},{...memo,id:'blank',questionId:'empty',body:' '},
    {...memo,id:'answered',resolvedBody:memo.body},
    {...memo,id:'edited',body:'追加の疑問',resolvedBody:memo.body});
  const pending = unexplainedNotes({...data,questions:qs},memos,'s1');
  assert.deepEqual(pending.map(n=>n.id),['empty','q1','image','edited']);
  const target = makeExplanationRequest(pending,{...data,questions:qs}).targets.find(t=>t.targetId==='question:q1');
  assert.deepEqual(target.memoBodies,[memo.body,'追加の疑問']);
  assert.equal(target.previousExplanation,'保存済み解説');
});
test('orphan cleanup keeps existing questions and legacy notes, with a recovery copy',async()=>{
  storage.clear();coordination.resetDataCoordinationForTests();
  const orphan={...memo,id:'gone',questionId:'deleted'};
  const legacy={id:'legacy',title:'旧メモ',body:'残す'};
  storage.set(NOTES_KEY,JSON.stringify([memo,orphan,legacy]));
  assert.deepEqual(await removeOrphanWeaknessNotes(['q1']),[memo,legacy]);
  assert.deepEqual(JSON.parse(storage.get(`${NOTES_KEY}-removed-orphans`)),[orphan]);
  assert.deepEqual(await removeOrphanWeaknessNotes(['q1']),[memo,legacy]);
});
async function setup(){storage.clear();coordination.resetDataCoordinationForTests();storage.set(NOTES_KEY,JSON.stringify([memo]));const request=makeExplanationRequest([memo],data);await rememberExplanationRequest(request);const text=JSON.stringify({version:1,requestId:request.id,explanations:[{targetId:'question:q1',body:'追加の解説'}]});return {request,text,batch:readExplanationBatch(text)};}
test('legacy free notes survive and malformed notes fail closed',async()=>{assert.deepEqual(parseNotes(JSON.stringify([{id:'old',title:'元のメモ',body:'本文'}])),[{id:'old',title:'元のメモ',body:'本文'}]);assert.throws(()=>parseNotes('{}'));assert.throws(()=>parseNotes('[{"id":1}]'));});
test('question updates append without changing answers, ordinary explanation, images or progress',async()=>{const {batch}=await setup();const next=applyQuestionExplanations(data,batch);assert.equal(next.questions[0].explanation,q.explanation);assert.deepEqual(next.questions[0].choices,q.choices);assert.deepEqual(next.questions[0].detailedAnswer.imageIds,['legacy-image']);assert.ok(next.questions[0].detailedAnswer.body.startsWith('保存済み解説'));assert.ok(next.questions[0].detailedAnswer.body.includes('追加の解説'));assert.deepEqual(next.progress,data.progress);assert.deepEqual(next.answerLogs,data.answerLogs);assert.equal(applyQuestionExplanations(next,batch).questions[0].detailedAnswer.body,next.questions[0].detailedAnswer.body);});
test('unknown request, wrong target, duplicates and empty answers are rejected',async()=>{const {request}=await setup();const val={version:1,requestId:request.id,explanations:[{targetId:'question:q1',body:'ok'}]};for(const bad of [{...val,requestId:'unknown'},{...val,explanations:[{targetId:'question:q2',body:'ok'}]},{...val,explanations:[...val.explanations,...val.explanations]},{...val,explanations:[{targetId:'question:q1',body:''}]}])assert.throws(()=>readExplanationBatch(JSON.stringify(bad)));});
test('changed or deleted questions abort the whole batch',async()=>{const {batch}=await setup();assert.throws(()=>applyQuestionExplanations({...data,questions:[]},batch));assert.throws(()=>applyQuestionExplanations({...data,questions:[{...q,question:'edited'}]},batch));assert.throws(()=>applyQuestionExplanations({...data,questions:[{...q,answerIndex:1}]},batch));});
test('later memo edits stay unresolved after importing the old request',async()=>{const {batch}=await setup();await changeWeaknessNotes(ns=>ns.map(n=>({...n,body:'追加の疑問'})));await finishExplanationBatch(batch);const n=readWeaknessNotes()[0];assert.equal(n.body,'追加の疑問');assert.equal(n.resolvedBody,'なぜA？');});
test('free memo explanations append and remain idempotent',async()=>{storage.clear();coordination.resetDataCoordinationForTests();const n={id:'free',title:'メモ',body:'疑問',explanation:'以前の解説'};storage.set(NOTES_KEY,JSON.stringify([n]));const request=makeExplanationRequest([n],data);await rememberExplanationRequest(request);const batch=readExplanationBatch(JSON.stringify({version:1,requestId:request.id,explanations:[{targetId:'memo:free',body:'新しい説明'}]}));await finishExplanationBatch(batch);const saved=readWeaknessNotes()[0];assert.ok(saved.explanation.startsWith('以前の解説'));await finishExplanationBatch(batch);assert.deepEqual(readWeaknessNotes()[0],saved);});
test('prompt conditions and problem identifiers are preserved',async()=>{const {request}=await setup();const p=explanationPrompt(request,{tables:true,images:true,examples:true});assert.ok(p.includes(request.id));assert.ok(p.includes('question:q1'));assert.ok(p.includes('なぜA？'));assert.ok(p.includes('通常解説は残す'));assert.ok(p.includes('Markdownの表'));assert.ok(p.includes('捏造しない'));});
test('normal answer markup and swipe rail remain separate from the new detail component',async()=>{const s=readFileSync(new URL('../src/screens/QuizRunner.tsx',import.meta.url),'utf8');assert.match(s,/<ExplanationContent text=\{explanation\}/);assert.match(s,/<WeaknessDetail key=\{questionId\}/);assert.match(s,/handleDetailPointerMove/);assert.match(s,/handleNextWithDraftCheck/);assert.doesNotMatch(s,/handleClipboardRead|handleSaveDetail =/);});

test('empty details retain a direct image picker without enabling read-only edits',async()=>{
  const source=readFileSync(new URL('../src/components/WeaknessDetail.tsx',import.meta.url),'utf8');
  assert.match(source, /<ExplanationReader questionId=\{questionId\} text=\{text\} imageIds=\{imageIds\} onSave=\{onSave\} onAddImage=\{onAddImage \? addImage : undefined\} onRemoveImage=\{onRemoveImage \? removeImage : undefined\} disabled=\{disabled \|\| guideExample !== undefined\}\/>/);
  assert.match(source, /if \(guideExample !== undefined\) return true/);
  assert.match(source, /if \(!active \|\| disabled \|\| guideExample !== undefined\) return/);
  assert.doesNotMatch(source, /text\.trim\(\)\?<ExplanationReader/);
  assert.match(source, /if \(!onSave \|\| disabled \|\| lock.current \|\| \(!text\.trim\(\) && !imageIds\.length\) \|\| !window\.confirm\(/);
  assert.match(source, /data-no-page-swipe disabled=\{busy\} onClick=\{\(\) => input.current\?\.click\(\)\}/);
  assert.match(source, /<input ref=\{input\} type="file"/);
});

test('one-shot explanation template imports with exact IDs and respects visual options',async()=>{
  const {request}=await setup();
  for(const enabled of [true,false]){
    const prompt=explanationPrompt(request,{tables:enabled,images:enabled,examples:enabled});
    assert.ok(prompt.includes('原則1回の回答で完成したJSON'));
    assert.ok(prompt.includes('今回の疑問だけに簡潔に'));
    assert.ok(prompt.includes(enabled?'Markdownの表':'表は不要'));
    assert.ok(prompt.includes(enabled?'JSONを省略しない':'画像は不要'));
    const example=prompt.split('\n').find(line=>line.startsWith('{"version"'));
    const batch=readExplanationBatch(example);
    const fence=String.fromCharCode(96).repeat(3);
    assert.ok(prompt.includes(fence+'json\n'+example+'\n'+fence));
    assert.deepEqual(readExplanationBatch(fence+'json\n'+example+'\n'+fence).replies,batch.replies);
    assert.ok(prompt.includes('jsonコードブロック1個'));
    assert.ok(!prompt.includes('Markdownコードフェンス、コメント'));
    assert.equal(batch.request.id,request.id);
    assert.deepEqual(batch.replies.map(r=>r.targetId),request.targets.map(t=>t.targetId));
    assert.ok(prompt.includes('コピーするJSONにも記号が必要'));
    assert.ok(prompt.includes('各bodyの**強調記号**'));
    for(const answer of batch.replies){
      assert.match(answer.body,/\*\*[^*]+\*\*/);
      const saved=applyQuestionExplanations(data,batch);
      assert.ok(saved.questions[0].detailedAnswer.body.includes(answer.body));
      assert.equal(saved.questions[0].explanation,q.explanation);
    }
    const reply=JSON.parse(example);
    reply.explanations[0].body='**重要語**\n\n|A|B|\n|---|---|\n|値|値|\n\n```flow\n条件 → 結果\n```';
    assert.equal(readExplanationBatch(JSON.stringify(reply)).replies[0].body,reply.explanations[0].body);
  }
});
