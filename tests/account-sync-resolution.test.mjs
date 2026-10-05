import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(s,c,next){return next(/^\.\.?\//u.test(s)&&!/\.[cm]?[jt]sx?$/u.test(s)&&c.parentURL?.endsWith('.ts')?s+'.ts':s,c)}});after(()=>hook.deregister());
const {resolveAccountSync,parseAccountResolverResult}=await import('../src/utils/accountSync.ts');
const identity={project:'https://test.supabase.co',userId:'a'},id='a'.repeat(36),other='b'.repeat(36);
function fixture({existing='',binding=null,result={code:'ok',syncId:id,created:true}}={}){
  const calls=[],installed=[];let current=true,syncId=existing;
  const deps={identity,assertCurrent:()=>{if(!current)throw Error('connection_changed')},readSyncId:()=>syncId,readBinding:async()=>binding,resolve:async c=>{calls.push(c);return result},install:async c=>installed.push(c)};
  return {deps,calls,installed,change:()=>{current=false},edit:c=>{syncId=c}};
}
test('new profiles resolve the same account stream without asking for an ID, and preserve a bound legacy stream',async()=>{
  for(const config of [{},{existing:id,binding:{...identity,syncId:id},result:{code:'ok',syncId:id,created:false}},{binding:{...identity,syncId:id},result:{code:'ok',syncId:id,created:false}}]){
    const f=fixture(config);assert.deepEqual(await resolveAccountSync(f.deps),{phase:'ready',syncId:id});assert.deepEqual(f.installed,[id]);
  }
});
test('multiple owned streams require selection; a changed canonical stream never resets the old binding',async()=>{
  const choices=[{syncId:id,updatedAt:'2026-10-04T00:00:00Z'},{syncId:other,updatedAt:'2026-10-03T00:00:00Z'}];
  const f=fixture({result:{code:'selection_required',choices}});assert.equal((await resolveAccountSync(f.deps)).phase,'selection_required');assert.deepEqual(f.installed,[]);
  const choice=fixture({result:{code:'ok',syncId:other,created:false}});await resolveAccountSync(choice.deps,other);assert.deepEqual(choice.calls,[other]);assert.deepEqual(choice.installed,[other]);
  for(const result of [{code:'migration_required',syncId:other},{code:'ok',syncId:other,created:false}]){
    const old=fixture({existing:id,binding:{...identity,syncId:id},result});assert.equal((await resolveAccountSync(old.deps)).phase,'migration_required');assert.deepEqual(old.installed,[]);
  }
});
test('foreign bindings, weak IDs, missing/deleted streams and malformed resolver replies never install a connection',async()=>{
  const foreign=fixture({existing:id,binding:{...identity,userId:'b',syncId:id}});await assert.rejects(resolveAccountSync(foreign.deps),/connection_changed/);assert.deepEqual(foreign.calls,[]);
  const weak=fixture({existing:'weak'});assert.equal((await resolveAccountSync(weak.deps)).phase,'legacy_connection');assert.deepEqual(weak.calls,[]);
  for(const code of ['not_found','deleted','legacy_connection']){const f=fixture({result:{code}});assert.equal((await resolveAccountSync(f.deps)).phase,code);assert.deepEqual(f.installed,[])}
  for(const result of [{},{code:'ok',syncId:id},{code:'ok',syncId:'weak',created:false},{code:'selection_required',choices:[]},{code:'unknown'},{code:'selection_required',choices:[{syncId:id,updatedAt:'broken'},{syncId:id,updatedAt:'broken'}]}])assert.throws(()=>parseAccountResolverResult(result),/invalid_response/);
});
test('account or sync ID changes while the RPC is pending preserve storage and prevent installation',async()=>{
  for(const transition of ['account','id']){
    const f=fixture();let release,entered;const waiting=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    f.deps.resolve=async()=>{entered();await waiting;return {code:'ok',syncId:id,created:true}};
    const pending=resolveAccountSync(f.deps);await started;if(transition==='account')f.change();else f.edit(other);release();await assert.rejects(pending,/connection_changed/);assert.deepEqual(f.installed,[]);
  }
});

test('a changed ID disables the old account marker immediately; only exact resolved markers enable automatic sync',async()=>{
  const storage=new Map(),native={get length(){return storage.size},key:i=>[...storage.keys()][i]??null,getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k),clear:()=>storage.clear()};
  const {AccountStorageSession,accountNamespace,activateAccountStorage}=await import('../src/utils/accountStorage.ts');
  const {accountAutomaticSyncEnabled,publishAccountSyncState,writeAccountSyncMarker,readAccountSyncMarker,pauseAccountSync}=await import('../src/utils/accountSync.ts');
  const owner=new AccountStorageSession(native,{identity,namespace:accountNamespace(identity),legacyUnclaimed:true});activateAccountStorage(owner);owner.storage.setItem('quizMake:sync:id',id);
  assert.equal(accountAutomaticSyncEnabled(),false);writeAccountSyncMarker(identity,id);publishAccountSyncState({phase:'ready',syncId:id});assert.equal(accountAutomaticSyncEnabled(),true);
  owner.storage.setItem('quizMake:sync:id',other);assert.equal(readAccountSyncMarker().syncId,id);assert.equal(accountAutomaticSyncEnabled(),false);
  writeAccountSyncMarker(identity,other);publishAccountSyncState({phase:'ready',syncId:other});assert.equal(accountAutomaticSyncEnabled(),true);pauseAccountSync(true);assert.equal(accountAutomaticSyncEnabled(),false);pauseAccountSync(false);assert.equal(accountAutomaticSyncEnabled(),true);
});
