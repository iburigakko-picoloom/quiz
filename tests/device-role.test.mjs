import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { changeDeviceRole, readDeviceRole, DEVICE_ROLE_KEY, isContentChange, assertMainDevice } from '../src/utils/deviceRole.ts';
const values = new Map();
globalThis.localStorage = { get length(){return values.size;}, key:i=>[...values.keys()][i]??null, getItem:k=>values.get(k)??null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k) };
globalThis.window = { dispatchEvent(){} };
globalThis.indexedDB = new IDBFactory();
const storage = await import('../src/storage.ts');
const records = await import('../src/utils/appRecordStorage.ts');
const stamp = '2026-11-07T00:00:00Z';
const data = {version:1,folders:[{id:'f',name:'保護対象',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'教材',source:'',createdAt:stamp,updatedAt:stamp}],questions:[],progress:[],answerLogs:[]};
const dependencies = () => ({storage:globalThis.localStorage, exclusive:async op=>{await op();return true;},flush:async()=>true,coordinate:op=>op(),assertSafe:async()=>{},changed(){}});
test('legacy installs remain main; corrupt/unreadable roles fail closed',()=>{
  values.clear(); assert.equal(readDeviceRole(),'main');
  values.set(DEVICE_ROLE_KEY,'corrupt'); assert.equal(readDeviceRole(),'sub');
  assert.equal(readDeviceRole({getItem(){throw Error('denied');}}),'sub');
});
test('role switch changes no durable app records, outbox, backup metadata or installation identity',async()=>{
  values.clear(); assert.equal(await storage.saveAppDataAsync(data),true);
  values.set('quizMakeDevice:v1','same-device');values.set('backup-marker','same-backup');
  const db=await storage.openAppDb(), before=await storage.loadAppDataAsync(),outbox=await records.readAppOutbox(db), snapshot=new Map(values);
  await changeDeviceRole('sub',dependencies());
  assert.equal(readDeviceRole(),'sub');assert.deepEqual(await storage.loadAppDataAsync(),before);assert.deepEqual(await records.readAppOutbox(db),outbox);
  assert.deepEqual(new Map([...values].filter(([key])=>key!==DEVICE_ROLE_KEY)),snapshot);
  await changeDeviceRole('main',dependencies()); assert.equal(readDeviceRole(),'main');assert.deepEqual(await storage.loadAppDataAsync(),before);
});
test('saving, other editor and conflict failures leave role and data intact',async()=>{
  values.set(DEVICE_ROLE_KEY,'main');const snapshot=new Map(values);
  for(const override of [{exclusive:async()=>false},{flush:async()=>false},{assertSafe:async()=>{throw Error('conflict');}},{coordinate:async()=>{throw Error('migration');}}]){
    await assert.rejects(changeDeviceRole('sub',{...dependencies(),...override}));assert.deepEqual(values,snapshot);
  }
});
test('failed role persistence restores previous setting',async()=>{
  values.set(DEVICE_ROLE_KEY,'main');let first=true;
  await assert.rejects(changeDeviceRole('sub',{...dependencies(),storage:{...localStorage,setItem(k,v){if(first){first=false;return;}localStorage.setItem(k,v);}}}));
  assert.equal(readDeviceRole(),'main');
});
test('sub-device guard runs inside durable save and rejects stale content; receive remains available',async()=>{
  values.set(DEVICE_ROLE_KEY,'sub');const before=await storage.loadAppDataAsync(),db=await storage.openAppDb(),outbox=await records.readAppOutbox(db);
  const edited={...before,folders:before.folders.map(f=>({...f,name:'rejected'}))};
  assert.equal((await storage.saveAppDataResult(edited,{assertBeforeSave:assertMainDevice})).ok,false);
  assert.deepEqual(await storage.loadAppDataAsync(),before);assert.deepEqual(await records.readAppOutbox(db),outbox);
  assert.equal((await storage.saveAppDataResult(edited)).ok,true,'sync/backup receive does not invoke author guard');
  assert.equal(readDeviceRole(),'sub');
});
test('answer/review/completion changes stay allowed, content edits are detected',()=>{
  assert.equal(isContentChange(data,{...data,progress:[{questionId:'q'}],answerLogs:[{id:'a'}]}),false);
  assert.equal(isContentChange(data,{...data,problemSets:data.problemSets.map(s=>({...s,isStudyCompleted:true,updatedAt:'later'}))}),false);
  assert.equal(isContentChange(data,{...data,problemSets:data.problemSets.map(s=>({...s,title:'edited'}))}),true);
  assert.equal(isContentChange(data,{...data,questions:[{id:'new'}]}),true);
});
