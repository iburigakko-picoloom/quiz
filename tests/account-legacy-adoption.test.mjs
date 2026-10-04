import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {registerHooks} from 'node:module';
import {IDBFactory} from 'fake-indexeddb';
const hook=registerHooks({resolve(s,c,next){return next(/^\.\.?\//u.test(s)&&!/\.[cm]?[jt]sx?$/u.test(s)&&c.parentURL?.endsWith('.ts')?s+'.ts':s,c)}});after(()=>hook.deregister());
Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name,_options,fn)=>fn()}});
const {AccountStorageSession,decideAccountStorage,ACCOUNT_VAULT_MANIFEST_KEY}=await import('../src/utils/accountStorage.ts');
const {hasUnclaimedLegacyData,preserveUnclaimedLegacyData,adoptUnclaimedLegacyData}=await import('../src/utils/accountLegacyAdoption.ts');
const {captureAccountWork,saveAccountWork,readLatestAccountWork,accountWorkDatabase}=await import('../src/utils/accountWork.ts');
function memory(){const values=new Map();return {get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()}}
const a={project:'https://test.supabase.co',userId:'a'},b={...a,userId:'b'};
async function populate(factory,binding){const db=await new Promise((resolve,reject)=>{const r=factory.open('quiz-make-app-data-v1',7);r.onupgradeneeded=()=>{r.result.createObjectStore('appRecordMeta');r.result.createObjectStore('questionImageBlobs')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});await new Promise((resolve,reject)=>{const tx=db.transaction(['appRecordMeta','questionImageBlobs'],'readwrite');tx.objectStore('questionImageBlobs').put(new Blob(['unchanged bytes']),'image');if(binding)tx.objectStore('appRecordMeta').put(binding,'recordSyncConnection');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close()}
test('absence/read-only inspection does not create or upgrade stores; decline preserves originals without assigning an owner',async()=>{
  const factory=new IDBFactory(),native=memory();assert.equal(await hasUnclaimedLegacyData(factory,native,a),false);assert.deepEqual(await factory.databases(),[]);
  native.setItem('quizMake:plan:1','{"kept":true}');assert.equal(await hasUnclaimedLegacyData(factory,native,a),true);preserveUnclaimedLegacyData(native,a);assert.equal(await hasUnclaimedLegacyData(factory,native,a),false);assert.equal(await hasUnclaimedLegacyData(factory,native,b),true);assert.equal(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY),null);assert.equal(native.getItem('quizMake:plan:1'),'{"kept":true}');
});
test('explicit adoption keeps DB/blob bytes and logical IDs in place; transfers a copy of guest drafts and isolates logout/B',async()=>{
  const factory=new IDBFactory(),native=memory();await populate(factory);const guest=new AccountStorageSession(native,decideAccountStorage(native,null,null)),copy=captureAccountWork(guest);copy.work={create:{title:'draft kept'}};await saveAccountWork(factory,accountWorkDatabase(guest),copy);
  native.setItem('quizMake:plan:1','original IDs');await adoptUnclaimedLegacyData(factory,native,a,()=>{});
  const own=new AccountStorageSession(native,decideAccountStorage(native,a,null)),other=new AccountStorageSession(native,decideAccountStorage(native,b,null)),signedOut=new AccountStorageSession(native,decideAccountStorage(native,null,null));
  assert.equal(own.namespace,'legacy');assert.equal(other.storage.getItem('quizMake:plan:1'),null);assert.equal(signedOut.storage.getItem('quizMake:plan:1'),null);assert.equal(own.storage.getItem('quizMake:plan:1'),'original IDs');
  assert.equal((await readLatestAccountWork(factory,own)).work.create.title,'draft kept');assert.throws(()=>accountWorkDatabase(guest),/所有者/);assert.ok((await factory.databases()).some(db=>db.name.endsWith(':signed-out')));
  assert.equal((await factory.databases()).find(db=>db.name==='quiz-make-app-data-v1').version,7);
});
test('bound, competing, nonempty destination and stale-account adoptions fail without changing manifest or local data',async()=>{
  for(const mode of ['bound','competing','destination','stale']){
    const factory=new IDBFactory(),native=memory();native.setItem('quizMake:plan:1','kept');
    if(mode==='bound')await populate(factory,{...b,syncId:'b'.repeat(36)});
    if(mode==='competing')native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,JSON.stringify({version:1,legacyOwner:b}));
    if(mode==='destination')new AccountStorageSession(native,decideAccountStorage(native,a,null)).storage.setItem('quizMake:plan:2','A kept');
    const before=native.getItem(ACCOUNT_VAULT_MANIFEST_KEY);await assert.rejects(adoptUnclaimedLegacyData(factory,native,a,()=>{if(mode==='stale')throw Error('account changed')}));assert.equal(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY),before);assert.equal(native.getItem('quizMake:plan:1'),'kept');
  }
});

test('local-only fallback notes, backups and unsaved guest work are detected even without a main DB',async()=>{
  for(const key of ['quizMake:notes:set:page','quizMake:sync:saved-backup:one']){const factory=new IDBFactory(),native=memory();native.setItem(key,'original');assert.equal(await hasUnclaimedLegacyData(factory,native,a),true);assert.deepEqual(await factory.databases(),[]);}
  const factory=new IDBFactory(),native=memory(),guest=new AccountStorageSession(native,decideAccountStorage(native,null,null)),snapshot=captureAccountWork(guest);snapshot.work={create:{title:'unsaved'}};await saveAccountWork(factory,accountWorkDatabase(guest),snapshot);assert.equal(await hasUnclaimedLegacyData(factory,native,a),true);
});
