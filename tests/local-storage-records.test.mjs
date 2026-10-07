import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
const hook=registerHooks({resolve(specifier,context,next){return next(/^\.\.?\//u.test(specifier)&&!/\.[cm]?[jt]sx?$/u.test(specifier)&&context.parentURL?.endsWith('.ts')?`${specifier}.ts`:specifier,context);}});
process.on('exit',()=>hook.deregister());
const items=new Map();let deny=false;
globalThis.localStorage={get length(){return items.size;},key:i=>[...items.keys()][i]??null,
  getItem:key=>items.get(key)??null,removeItem:key=>items.delete(key),setItem(key,value){if(deny&&key==='quizMake:settings-cache')throw new Error('projection failed');items.set(key,String(value));}};
const events=[];globalThis.window={dispatchEvent(event){events.push(event.type)}};globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const storage=await import('../src/storage.ts');
const {saveSyncedLocalStorage,replayLocalStorageProjections,captureSyncedLocalStorage}=await import('../src/utils/localStorageRecords.ts');
const {readAppOutbox}=await import('../src/utils/appRecordStorage.ts');
async function get(db,store,key){const tx=db.transaction(store);const result=tx.objectStore(store).get(key);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});return result.result;}

test('a remote character preference refreshes the same mounted tab after projection without a new user edit',async()=>{
  await storage.saveAppData(storage.createEmptyAppData());const db=await storage.openAppDb(),key='quiz-make-study-companion';
  const generation=await get(db,'appRecordMeta','userEditGenerationV1');
  const tx=db.transaction('localProjections','readwrite');tx.objectStore('localProjections').put('off',key);await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});
  events.length=0;await replayLocalStorageProjections(db,[key]);assert.equal(localStorage.getItem(key),'off');assert.equal(events.filter(event=>event==='quiz-make-study-companion-change').length,1);assert.equal(await get(db,'appRecordMeta','userEditGenerationV1'),generation);
  await replayLocalStorageProjections(db,[key]);assert.equal(events.filter(event=>event==='quiz-make-study-companion-change').length,1);
});
test('localStorage projection replays after a crash without dropping atomic Outbox and two keys share one commit',async()=>{
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()),true);
  const main='quizMake:settings-cache',recovery=`${main}-recovery`;
  deny=true;
  await assert.rejects(saveSyncedLocalStorage({[main]:'[{"id":"memo"}]',[recovery]:'[]'}),/projection failed/);
  const db=await storage.openAppDb();
  assert.equal(localStorage.getItem(main),null);
  assert.equal(await get(db,'localProjections',main),'[{"id":"memo"}]');
  const ops=(await readAppOutbox(db)).filter(op=>op.collection==='localStorage');
  assert.equal(ops.length,2);
  assert.equal(new Set(ops.map(op=>op.localRevision)).size,1);
  deny=false;await replayLocalStorageProjections();
  assert.equal(localStorage.getItem(main),'[{"id":"memo"}]');
  assert.equal(localStorage.getItem(recovery),'[]');
  assert.equal(await get(db,'localProjections',main),undefined);
  assert.deepEqual((await readAppOutbox(db)).filter(op=>op.collection==='localStorage'),ops);
});

test('chunk preparation keeps the full native cache and capture never requeues transport records',async()=>{
  const {bindRecordSyncConnection}=await import('../src/utils/recordSyncOutbox.ts');
  const {prepareRecordChunks}=await import('../src/utils/recordChunks.ts');
  const db=await storage.openAppDb(),id='quizMake:chunk-capture-test',raw=JSON.stringify({value:'x'.repeat(950000)});
  const connection={project:'https://test.invalid',userId:'owner',syncId:'a'.repeat(36)};
  await bindRecordSyncConnection(db,connection);await saveSyncedLocalStorage({[id]:raw});await prepareRecordChunks(db,connection);
  const before=await readAppOutbox(db),parent=await get(db,'appRecords',JSON.stringify(['localStorage',id]));
  assert.equal(parent.logicalRaw,raw);assert.equal(localStorage.getItem(id),raw);
  assert.ok(before.some(op=>op.id.startsWith('quizMake:recordChunks:v1:')));
  const filter=key=>key===id||key.startsWith('quizMake:recordChunks:')||key==='quizMake:plan:__record_chunks_v1';
  assert.equal(await captureSyncedLocalStorage(filter),0);
  assert.deepEqual(await readAppOutbox(db),before);
  assert.ok(![...items.keys()].some(key=>key.startsWith('quizMake:recordChunks:')||key==='quizMake:plan:__record_chunks_v1'));
  localStorage.removeItem(id);assert.equal(await captureSyncedLocalStorage(filter),1);
  assert.equal((await readAppOutbox(db)).find(op=>op.id===id).raw,null);
});

test('legacy settings capture only changed synchronized keys and never scans AppData',async()=>{
  const db=await storage.openAppDb();
  const original=db.transaction.bind(db);
  db.transaction=(stores,...args)=>{
    const tx=original(stores,...args);const objectStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=objectStore(name);
      if(name==='appRecords'){const getAll=store.getAll.bind(store);store.getAll=range=>{assert.equal(range?.lower,'[\"localStorage\",');return getAll(range);};}
      return store;
    };
    return tx;
  };
  try {
    localStorage.setItem('quizMake:settings','a');
    const filter=key=>key==='quizMake:settings';
    assert.equal(await captureSyncedLocalStorage(filter),1);
    assert.equal(await captureSyncedLocalStorage(filter),0);
    localStorage.setItem('quizMake:settings','b');
    assert.equal(await captureSyncedLocalStorage(filter),1);
    localStorage.removeItem('quizMake:settings');
    assert.equal(await captureSyncedLocalStorage(filter),1);
    const op=(await readAppOutbox(db)).find(value=>value.id==='quizMake:settings');
    assert.equal(op.raw,null);
  } finally {db.transaction=original;db.close();}
});
