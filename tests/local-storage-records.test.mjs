import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
const hook=registerHooks({resolve(specifier,context,next){return next(/^\.\.?\//u.test(specifier)&&!/\.[cm]?[jt]sx?$/u.test(specifier)&&context.parentURL?.endsWith('.ts')?`${specifier}.ts`:specifier,context);}});
process.on('exit',()=>hook.deregister());
const items=new Map();let deny=false;
globalThis.localStorage={get length(){return items.size;},key:i=>[...items.keys()][i]??null,
  getItem:key=>items.get(key)??null,removeItem:key=>items.delete(key),setItem(key,value){if(deny&&key==='quiz-make-creation-notes-v1')throw new Error('projection failed');items.set(key,String(value));}};
globalThis.window={dispatchEvent(){}};globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const storage=await import('../src/storage.ts');
const {saveSyncedLocalStorage,replayLocalStorageProjections,captureSyncedLocalStorage}=await import('../src/utils/localStorageRecords.ts');
const {readAppOutbox}=await import('../src/utils/appRecordStorage.ts');
async function get(db,store,key){const tx=db.transaction(store);const result=tx.objectStore(store).get(key);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});return result.result;}
test('localStorage projection replays after a crash without dropping atomic Outbox and two keys share one commit',async()=>{
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()),true);
  const main='quiz-make-creation-notes-v1',recovery=`${main}-removed-orphans`;
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

test('legacy settings capture only changed synchronized keys and never scans AppData',async()=>{
  const db=await storage.openAppDb();
  const original=db.transaction.bind(db);
  db.transaction=(stores,...args)=>{
    const tx=original(stores,...args);const objectStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=objectStore(name);
      if(name==='appRecords')store.getAll=()=>assert.fail('must not scan the AppData rows');
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
