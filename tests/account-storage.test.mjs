import assert from 'node:assert/strict';
import test from 'node:test';
import {AccountStorageSession,accountNamespace,decideAccountStorage,ACCOUNT_VAULT_MANIFEST_KEY} from '../src/utils/accountStorage.ts';
function memory(){const values=new Map();return {get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()}}
const a={project:'https://project.supabase.co',userId:'account-a'},b={...a,userId:'account-b'};
test('bound legacy records are retained in place for A and hidden from B and signed-out guest',()=>{
  const native=memory();native.setItem('quiz-make-app-data-v1','A questions');native.setItem('quizMake:sync:id','old-sync-id');native.setItem('sb-project-auth-token','auth credential');
  const own=new AccountStorageSession(native,decideAccountStorage(native,a,{...a,syncId:'old-sync-id'})),other=new AccountStorageSession(native,decideAccountStorage(native,b,a)),guest=new AccountStorageSession(native,decideAccountStorage(native,null,a));
  assert.equal(own.namespace,'legacy');assert.equal(own.storage.getItem('quiz-make-app-data-v1'),'A questions');assert.equal(other.storage.getItem('quiz-make-app-data-v1'),null);assert.equal(guest.storage.getItem('quiz-make-app-data-v1'),null);assert.equal(own.storage.getItem('sb-project-auth-token'),null);assert.equal(native.getItem('quiz-make-app-data-v1'),'A questions');
  assert.notEqual(own.databaseName('quiz-make-app-data-v1'),other.databaseName('quiz-make-app-data-v1'));assert.equal(other.databaseName('quiz-make-app-data-v1'),`quiz-make-account-v1:${accountNamespace(b)}:quiz-make-app-data-v1`);
});
test('unclaimed old local data is never assigned to whichever account logs in first',()=>{
  const native=memory();native.setItem('quiz-make-app-data-v1','unclaimed questions');const signed=decideAccountStorage(native,a,null),guest=decideAccountStorage(native,null,null);
  assert.equal(signed.legacyUnclaimed,true);assert.notEqual(signed.namespace,'legacy');assert.equal(guest.namespace,'legacy');assert.equal(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY),null);assert.equal(native.getItem('quiz-make-app-data-v1'),'unclaimed questions');
});
test('per-account questions, plan settings, epochs, sync IDs and backups never cross storage scopes',()=>{
  const native=memory(),first=new AccountStorageSession(native,decideAccountStorage(native,a,null)),second=new AccountStorageSession(native,decideAccountStorage(native,b,null));
  for(const key of ['quiz-make-app-data-v1','quizMake:study:plans','quizMake:coord:appEpoch','quizMake:sync:id','quizMake:sync:saved-backup:1']){first.storage.setItem(key,'A');second.storage.setItem(key,'B');assert.equal(first.storage.getItem(key),'A');assert.equal(second.storage.getItem(key),'B')}
  assert.equal(first.storage.length,5);assert.equal(second.storage.length,5);assert.equal(first.storage.key(0),'quiz-make-app-data-v1');assert.equal(second.eventKey(native.key(0)),null);
  second.storage.clear();assert.equal(second.storage.length,0);assert.equal(first.storage.length,5);
});
test('late writes stay attached to their captured owner and account changes fence new writes and database opens',()=>{
  const native=memory(),first=new AccountStorageSession(native,decideAccountStorage(native,a,null)),second=new AccountStorageSession(native,decideAccountStorage(native,b,null));first.storage.setItem('quiz-make-app-data-v1','A');first.invalidate();
  assert.throws(()=>first.storage.setItem('quiz-make-app-data-v1','late'),/アカウントが変わりました/);assert.throws(()=>first.databaseName('quiz-make-app-data-v1'),/アカウントが変わりました/);assert.throws(()=>second.assertCurrent(a),/アカウントが変わりました/);assert.equal(first.storage.getItem('quiz-make-app-data-v1'),'A');assert.equal(second.storage.getItem('quiz-make-app-data-v1'),null);
});
test('corrupt ownership, competing bindings and failed manifest writes fail closed without replacing originals',()=>{
  for(const raw of ['broken','null','{}','{"version":2,"legacyOwner":null}']){const native=memory();native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,raw);native.setItem('quiz-make-app-data-v1','kept');assert.throws(()=>decideAccountStorage(native,a,null));assert.equal(native.getItem('quiz-make-app-data-v1'),'kept');assert.equal(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY),raw)}
  const native=memory();decideAccountStorage(native,a,a);assert.throws(()=>decideAccountStorage(native,b,b),/一致しません/);const quota={...memory(),setItem(){throw new DOMException('quota','QuotaExceededError')}};assert.throws(()=>decideAccountStorage(quota,a,a),{name:'QuotaExceededError'});
});
test('different projects and auth storage remain separate, including key enumeration and clear',()=>{
  const native=memory();native.setItem('sb-auth-token','kept');const first=new AccountStorageSession(native,decideAccountStorage(native,a,null)),other=new AccountStorageSession(native,decideAccountStorage(native,{...a,project:'https://other.supabase.co'},null));first.storage.setItem('quizMake:sync:id','A');assert.equal(other.storage.getItem('quizMake:sync:id'),null);assert.throws(()=>first.storage.setItem('sb-auth-token','changed'));assert.equal(first.storage.getItem(ACCOUNT_VAULT_MANIFEST_KEY),null);first.storage.clear();assert.equal(native.getItem('sb-auth-token'),'kept');
});

test('a stale unclaimed guest cannot write into legacy data after another tab adopts it',()=>{
  const native=memory(),guest=new AccountStorageSession(native,decideAccountStorage(native,null,null));guest.storage.setItem('quizMake:plan:kept','original');
  native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,JSON.stringify({version:1,legacyOwner:a}));
  assert.throws(()=>guest.storage.setItem('quizMake:plan:kept','stale'),/所有者/);assert.throws(()=>guest.databaseName('quiz-make-app-data-v1'),/所有者/);assert.equal(native.getItem('quizMake:plan:kept'),'original');
});
