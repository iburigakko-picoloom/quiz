import assert from 'node:assert/strict';
import test from 'node:test';
import { readOwnedUnionCloud, decodeUnionRecords, readArchivedUnionLocal } from '../src/utils/accountUnionSource.ts';
import { IDBFactory } from 'fake-indexeddb';
import { ACCOUNT_VAULT_MANIFEST_KEY } from '../src/utils/accountStorage.ts';
import { encodeRecordChunks, RECORD_CHUNK_GUARD_ID, RECORD_CHUNK_GUARD_RAW } from '../src/utils/recordChunkFormat.ts';
import { appRecordKey } from '../src/utils/appRecordStorage.ts';
const identity={project:'https://union-qa.invalid',userId:'owner'},id='a'.repeat(36);
function reader(overrides={}){const calls=[];return {identity,calls,assertCurrent(){},async resolveOwned(){calls.push('ownership');return{code:'ok',syncId:id,created:false}},async meta(){calls.push('meta');return{updatedAt:'2026-10-05T00:00:00Z'}},async open(){calls.push('open');return 0},async pull(){calls.push('pull');return{code:'ok',cursor:0,head:0,hasMore:false,batches:[]}},...overrides};}
test('ownership proof must precede any legacy RPC that could claim an unowned ID; other/missing/deleted/unknown owners never trigger reads',async()=>{
  const own=reader();await readOwnedUnionCloud(own,id,'old');assert.deepEqual(own.calls,['ownership','meta','open','pull']);
  for(const code of ['not_found','deleted','selection_required','legacy_connection']){const r=reader({async resolveOwned(){return code==='selection_required'?{code,choices:[{syncId:id,updatedAt:'2026-01-01'},{syncId:'b'.repeat(36),updatedAt:'2026-01-01'}]}:{code}}});await assert.rejects(readOwnedUnionCloud(r,id,'unsafe'));assert.deepEqual(r.calls,[]);}
  const wrong=reader({async resolveOwned(){return{code:'ok',syncId:'b'.repeat(36),created:false}}});await assert.rejects(readOwnedUnionCloud(wrong,id,'wrong'),/一致しません/);assert.deepEqual(wrong.calls,[]);
});
test('canonical selection may verify another owned stream while account changes abort before any subsequent read',async()=>{
  const r=reader({async resolveOwned(){return{code:'migration_required',syncId:'b'.repeat(36)}}});const data=await readOwnedUnionCloud(r,id,'old owned');assert.equal(data.syncId,id);
  let changed=false;const stopped=reader({async resolveOwned(){changed=true;return{code:'ok',syncId:id,created:false}},assertCurrent(){if(changed)throw Error('account changed')}});await assert.rejects(readOwnedUnionCloud(stopped,id,'old'),/account changed/);assert.deepEqual(stopped.calls,[]);
});
test('full history retains stable tombstone ancestry and rejects discontinuities or shrinking heads',async()=>{
  const key=appRecordKey('localStorage','quizMake:test'),raw='original';const r=reader({async open(){return 2},async pull(){return{code:'ok',cursor:2,head:2,hasMore:false,batches:[{revision:1,changes:[{key,collection:'localStorage',id:'quizMake:test',raw,position:0,revision:1}]},{revision:2,changes:[{key,collection:'localStorage',id:'quizMake:test',raw:null,position:0,revision:2}]}]}}});const data=await readOwnedUnionCloud(r,id,'old');assert.equal(data.records[0].raw,null);assert.equal(data.records[0].previousRaw,raw);
  await assert.rejects(readOwnedUnionCloud(reader({async open(){return 2}}),id,'shrinking'),/巻き戻/);await assert.rejects(readOwnedUnionCloud(reader({async pull(){return{code:'ok',cursor:2,head:2,hasMore:false,batches:[{revision:2,changes:[]}]}}}),id,'broken'));
});
test('chunk transport is hydrated with byte verification before union; missing or altered parts fail without substituting empty data',async()=>{
  const name='quizMake:large',raw='日本語・'.repeat(70000),encoded=await encodeRecordChunks('localStorage',name,raw),row=(id,raw)=>({key:appRecordKey('localStorage',id),collection:'localStorage',id,raw,position:0,revision:1});const records=[row(name,encoded.raw),row(RECORD_CHUNK_GUARD_ID,RECORD_CHUNK_GUARD_RAW),...encoded.parts.map(p=>row(p.id,p.raw))];const decoded=await decodeUnionRecords(records);assert.equal(decoded.length,1);assert.equal(decoded[0].raw,raw);await assert.rejects(decodeUnionRecords(records.slice(0,-1)));const bad=structuredClone(records);bad.at(-1).raw=bad.at(-1).raw.replace('"bytes":','"bytes":1,"invalidBytes":');await assert.rejects(decodeUnionRecords(bad));
});
function memory(){const map=new Map();return{get length(){return map.size},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
async function seedDb(factory,name,stores){const db=await new Promise((r,j)=>{const q=factory.open(name,1);q.onupgradeneeded=()=>Object.keys(stores).forEach(s=>q.result.createObjectStore(s));q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const tx=db.transaction(Object.keys(stores),'readwrite');Object.entries(stores).forEach(([store,values])=>Object.entries(values).forEach(([key,value])=>tx.objectStore(store).put(value,key)));await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});db.close();}
function legacyData(){return{version:1,folders:[{id:'f',name:'Old'}],problemSets:[{id:'s',folderId:'f',title:'Old'}],questions:[{id:'q',setId:'s',question:'Old question',choices:['A','B','C','D'],answerIndex:0}],progress:[],answerLogs:[{id:'saved-event',questionId:'q',selectedIndex:0,isCorrect:true,answeredAt:'2026-10-05T00:00:00Z'}]};}
const keyFilter=k=>k.startsWith('quizMake:')&&!k.startsWith('quizMake:sync:');
test('archived legacy IDB-only data, actual image blobs and notes are read without creating, normalizing away or modifying originals',async()=>{
  const factory=new IDBFactory(),native=memory(),app=legacyData(),raw=JSON.stringify(app),note='[{"body":"Original note"}]';native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,JSON.stringify({version:1,legacyOwner:identity,archived:true}));
  await seedDb(factory,'quiz-make-app-data-v1',{appData:{'quiz-make-app-data-v1':raw}});await seedDb(factory,'quiz-make-notes-v1',{categoryNotes:{'quizMake:notes:s:c':note}});
  const blob=new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'}),image={id:'image',questionId:'q',name:'original.png',type:'image/png',blob,addedAt:'2026-10-05T00:00:00Z'};await seedDb(factory,'quiz-make-local-question-images-v1',{images:{image}});
  const snapshot=await readArchivedUnionLocal(factory,native,identity,()=>{},keyFilter);assert.equal(snapshot.records.filter(r=>r.collection==='answerLogs').length,1);assert.equal(JSON.parse(snapshot.records.find(r=>r.collection==='answerLogs').raw).id,'saved-event');assert.equal(snapshot.records.find(r=>r.collection==='indexedDbNotes').raw,note);const descriptor=JSON.parse(snapshot.records.find(r=>r.collection==='questionImages').raw);assert.equal(descriptor.size,4);assert.match(descriptor.sha256,/^[a-f0-9]{64}$/);assert.equal(native.getItem('quiz-make-app-data-v1'),null);
  const names=await factory.databases();assert.deepEqual(names.map(r=>r.name).sort(),['quiz-make-app-data-v1','quiz-make-local-question-images-v1','quiz-make-notes-v1']);
  native.setItem('quiz-make-app-data-v1',JSON.stringify({...app,answerLogs:[]}));await assert.rejects(readArchivedUnionLocal(factory,native,identity,()=>{},keyFilter),/本体と控え/);
});
test('archived ownership, malformed saved events and unresolved frozen sends stop before unsafe reads or migration',async()=>{
  const factory=new IDBFactory(),native=memory();native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,JSON.stringify({version:1,legacyOwner:{...identity,userId:'other'},archived:true}));await assert.rejects(readArchivedUnionLocal(factory,native,identity,()=>{},keyFilter),/アカウント/);assert.deepEqual(await factory.databases(),[]);
  native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,JSON.stringify({version:1,legacyOwner:identity,archived:true}));const app=legacyData();app.answerLogs[0].questionId='missing';native.setItem('quiz-make-app-data-v1',JSON.stringify(app));await assert.rejects(readArchivedUnionLocal(factory,native,identity,()=>{},keyFilter),/欠落/);assert.deepEqual(await factory.databases(),[]);
  for(const key of ['quiz-make-app-data-v1:recovery-required','quiz-make-note-storage-v1:recovery-required']){native.setItem(key,'required');await assert.rejects(readArchivedUnionLocal(factory,native,identity,()=>{},keyFilter),/復旧確認/);native.removeItem(key);assert.deepEqual(await factory.databases(),[]);}
  await seedDb(factory,'quiz-make-app-data-v1',{appRecordMeta:{pushBatch:{connection:{...identity,syncId:id},operations:[]}}});await assert.rejects(readArchivedUnionLocal(factory,native,identity,()=>{},keyFilter),/送信結果/);
});
