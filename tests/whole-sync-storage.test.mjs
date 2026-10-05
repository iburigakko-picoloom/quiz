import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};globalThis.window={dispatchEvent(){}};
Object.defineProperty(navigator,'locks',{value:{request:async(_name,_options,run)=>run()},configurable:true});Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1024*1024*1024,usage:0})},configurable:true});
const storage=await import('../src/storage.ts');
const {readUserEditGeneration}=await import('../src/utils/userEditGeneration.ts');
const {createCompleteFileBackup,applyWholeSyncFile}=await import('../src/utils/backupPayload.ts');
const {stageWholePage,readWholeRows,queueWholeReplacement,readWholeBaseline,putWholeMeta,acknowledgeWholeUpload,acknowledgeIdenticalWhole}=await import('../src/utils/wholeSyncStorage.ts');
const {readAppOutbox}=await import('../src/utils/appRecordStorage.ts');
const {computeWholeRecordDigest,wholeHash}=await import('../src/utils/wholeSyncDigest.ts');
const {withCoordinatedDataMutation}=await import('../src/utils/dataCoordination.ts');
const {listWholeRecovery,getWholeRecovery}=await import('../src/utils/wholeRecovery.ts');
const stamp='2026-10-05T00:00:00Z',connection={project:'https://whole.invalid',userId:'11111111-1111-4111-8111-111111111111',syncId:'1'.repeat(36)};
const folder=name=>({id:'f',name,createdAt:stamp,updatedAt:stamp});
const data=name=>({version:1,folders:[folder(name)],problemSets:[],questions:[],progress:[],answerLogs:[]});
const row=(id,name,revision=4)=>({key:JSON.stringify(['folders',id]),collection:'folders',id,raw:JSON.stringify({...folder(name),id}),position:0,revision});
const page=(rows,revision=4,more=false,afterKey='')=>({code:'ok',revision,rows,afterKey:rows.length?rows[rows.length-1].key:afterKey,hasMore:more});
assert.equal(await storage.saveAppDataAsync(data('local')),true);const db=await storage.openAppDb();after(()=>db.close());
async function incoming(rows,revision){await stageWholePage(db,connection,revision,'',page(rows,revision));const app={...data('unused'),folders:rows.map(r=>JSON.parse(r.raw))};return createCompleteFileBackup({version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(app)},indexedDbNotes:{}},[])}
test('whole receive is staged without changing live data; replays, cross-account and duplicate keys fail safely',async()=>{
  const a=row('a','A'),b=row('b','B');await stageWholePage(db,connection,4,'',page([a],4,true));
  assert.equal((await storage.loadAppDataAsync()).folders[0].name,'local');
  await stageWholePage(db,connection,4,a.key,page([b]));assert.equal((await readWholeRows(db,connection,4)).length,2);
  await assert.rejects(stageWholePage(db,connection,4,a.key,page([b])));
  await assert.rejects(stageWholePage(db,{...connection,userId:'intruder'},4,'',page([a])));
  await stageWholePage(db,connection,4,'',page([a],4,true));
  await assert.rejects(stageWholePage(db,connection,4,a.key,page([a],4,false)));
  assert.equal((await storage.loadAppDataAsync()).folders[0].name,'local');
});
test('normal whole apply replaces the selected graph in one transaction without union, archive or dirty-generation increase',async()=>{
  const rows=[row('cloud','Cloud')],file=await incoming(rows,4),generation=await readUserEditGeneration(db),baseline={version:1,connection,serverRevision:4,userGeneration:generation,digest:await computeWholeRecordDigest(rows)};
  const result=await withCoordinatedDataMutation(['app','notes'],()=>applyWholeSyncFile(file,generation,tx=>queueWholeReplacement(tx,rows,baseline)),{requireCrossContext:true});assert.equal(result.ok,true,result.error);
  assert.deepEqual((await storage.loadAppDataAsync()).folders.map(f=>f.id),['cloud']);assert.equal((await readAppOutbox(db)).length,0);assert.deepEqual(await listWholeRecovery(),[]);
  assert.equal(await readUserEditGeneration(db),generation);assert.deepEqual(await readWholeBaseline(db,connection),baseline);
});
test('changed generations reject a shown choice; explicit cloud choice archives the entire nonselected local state',async()=>{
  const previous=await storage.loadAppDataAsync();assert.equal(await storage.saveAppDataAsync({...previous,folders:[...previous.folders,folder('new local folder')]}),true);
  const rows=[row('cloud','Cloud newer',5)],file=await incoming(rows,5),generation=await readUserEditGeneration(db),baseline={version:1,connection,serverRevision:5,userGeneration:generation,digest:await computeWholeRecordDigest(rows)};
  const stale=await withCoordinatedDataMutation(['app','notes'],()=>applyWholeSyncFile(file,generation-1,()=>{}));assert.equal(stale.ok,false);
  assert.equal((await storage.loadAppDataAsync()).folders.length,2);
  const applied=await withCoordinatedDataMutation(['app','notes'],()=>applyWholeSyncFile(file,generation,tx=>queueWholeReplacement(tx,rows,baseline),true));assert.equal(applied.ok,true,applied.error);
  assert.equal((await storage.loadAppDataAsync()).folders.length,1);assert.equal(await readUserEditGeneration(db),generation);
  const copies=await listWholeRecovery();assert.equal(copies.length,1);assert.equal(copies[0].kind,'conflict');assert.equal(JSON.parse(JSON.parse(await getWholeRecovery(copies[0].id)).localStorage['quiz-make-app-data-v1']).folders.length,2);
});
test('a lost whole upload acknowledgement retains concurrent local edits and only retires exact frozen Outbox UUIDs',async()=>{
  const prior=await storage.loadAppDataAsync();assert.equal(await storage.saveAppDataAsync({...prior,folders:[{...prior.folders[0],name:'upload version'}]}),true);
  const generation=await readUserEditGeneration(db),outbox=await readAppOutbox(db),raw=JSON.stringify(outbox.map(op=>({key:op.key,collection:op.collection,id:op.id,raw:op.raw,position:op.position})));
  const frozen={version:1,connection,id:crypto.randomUUID(),expectedRevision:5,generation,digest:await computeWholeRecordDigest(outbox),wireDigest:await wholeHash(await wholeHash(raw)),parts:[{id:crypto.randomUUID(),raw}],records:outbox.length,device:'QA',replace:false,outbox:outbox.map(op=>({key:op.key,operationId:op.operationId}))};
  await putWholeMeta(db,'wholeFrozen',frozen);
  const current=await storage.loadAppDataAsync();assert.equal(await storage.saveAppDataAsync({...current,folders:[{...current.folders[0],name:'newest local version'}]}),true);
  await acknowledgeWholeUpload(db,frozen,6);assert.equal((await storage.loadAppDataAsync()).folders[0].name,'newest local version');assert.ok((await readAppOutbox(db)).length);
  assert.equal((await readWholeBaseline(db,connection)).userGeneration,generation);assert.equal(await readUserEditGeneration(db),generation+1);
  await assert.rejects(acknowledgeIdenticalWhole(db,{version:1,connection,serverRevision:6,userGeneration:generation,digest:frozen.digest}));assert.ok((await readAppOutbox(db)).length);
});
