import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {registerHooks} from 'node:module';
import {IDBFactory} from 'fake-indexeddb';
const hook=registerHooks({resolve(s,c,next){return next(/^\.\.?\//u.test(s)&&!/\.[cm]?[jt]sx?$/u.test(s)&&c.parentURL?.endsWith('.ts')?s+'.ts':s,c)}});after(()=>hook.deregister());
const {AccountStorageSession}=await import('../src/utils/accountStorage.ts');
const {registerAccountWork,captureAccountWork,flushAccountWork,saveAccountWork,readLatestAccountWork,accountWorkDatabase,restoreAccountWork,getRestoredAccountWork,consumeRestoredAccountWork}=await import('../src/utils/accountWork.ts');
const a={project:'https://test.supabase.co',userId:'a'},b={...a,userId:'b'};
const native={getItem:key=>key==='quizMakeAccountVault:v1'?JSON.stringify({version:1,legacyOwner:a}):null},owner=new AccountStorageSession(native,{identity:a,namespace:'legacy',legacyUnclaimed:false});
test('checkpoint retains imported media bytes, nested drafts and immutable owner through IndexedDB/restart',async()=>{
  const factory=new IDBFactory(),draft={title:'unsaved',prepared:[{file:new Blob(['image bytes'],{type:'image/png'}),questions:[{text:'draft question'}]}]};
  const unregister=registerAccountWork('import',()=>draft);const copy=captureAccountWork(owner);unregister();draft.title='later';draft.prepared[0].questions[0].text='later';
  await saveAccountWork(factory,accountWorkDatabase(owner),copy);const read=await readLatestAccountWork(factory,owner);
  assert.equal(read.work.import.title,'unsaved');assert.equal(read.work.import.prepared[0].questions[0].text,'draft question');assert.equal(await read.work.import.prepared[0].file.text(),'image bytes');
  restoreAccountWork(read,owner);assert.equal(getRestoredAccountWork('import').title,'unsaved');consumeRestoredAccountWork('import');assert.equal(getRestoredAccountWork('import'),undefined);
});
test('guest, legacy A and B checkpoints have distinct database names and reject foreign ownership',async()=>{
  const factory=new IDBFactory(),guest=new AccountStorageSession({getItem:()=>null},{identity:null,namespace:'legacy',legacyUnclaimed:true});
  assert.notEqual(accountWorkDatabase(owner),accountWorkDatabase(guest));
  const snapshot={...captureAccountWork(owner),identity:b};await saveAccountWork(factory,accountWorkDatabase(owner),snapshot);
  await assert.rejects(readLatestAccountWork(factory,owner),/所有記録/);assert.throws(()=>restoreAccountWork(snapshot,owner),/別のアカウント/);
});
test('failed canvas/answer flush prevents switching; unsupported drafts cannot replace recovery bytes',async()=>{
  const stop=registerAccountWork('blocked',()=>({draft:'kept'}),async()=>{throw Error('save failed')});await assert.rejects(flushAccountWork(),/save failed/);stop();
  const factory=new IDBFactory(),snapshot=captureAccountWork(owner);await saveAccountWork(factory,accountWorkDatabase(owner),snapshot);
  await assert.rejects(saveAccountWork(factory,accountWorkDatabase(owner),{...snapshot,work:{unsupported:new Map([['lost','data']])}}),/保存できない値/);
  assert.deepEqual((await readLatestAccountWork(factory,owner)).work,snapshot.work);
  const unregister=registerAccountWork('bad',()=>({func(){}}));assert.throws(()=>captureAccountWork(owner),{name:'DataCloneError'});unregister();
});
test('missing recovery DB is not created; reading picks the latest unresumed copy and retains originals',async()=>{
  const factory=new IDBFactory();assert.equal(await readLatestAccountWork(factory,owner),null);assert.deepEqual(await factory.databases(),[]);
  for(const [date,resumed]of [['2026-10-03T00:00:00Z',false],['2026-10-04T00:00:00Z',false],['2026-10-05T00:00:00Z',true]])await saveAccountWork(factory,accountWorkDatabase(owner),{...captureAccountWork(owner),createdAt:date,resumed});
  assert.equal((await readLatestAccountWork(factory,owner)).createdAt,'2026-10-04T00:00:00Z');
});
