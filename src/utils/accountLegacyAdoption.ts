import { ACCOUNT_VAULT_MANIFEST_KEY, AccountStorageSession, accountNamespace, sameLocalAccount, validateLocalAccountIdentity, type LocalAccountIdentity } from './accountStorage';
import { readStoredAccountBinding } from './accountStorageBootstrap';
import { accountWorkDatabase, readLatestAccountWork, saveAccountWork } from './accountWork';
import { withCoordinatedDataRead } from './dataCoordination';

const choiceKey=(identity:LocalAccountIdentity)=>'quizMakeAccountVault:legacyChoice:'+accountNamespace(identity);
async function databaseHasRows(factory:IDBFactory,name:string):Promise<boolean>{
  const db=await new Promise<IDBDatabase|null>((resolve,reject)=>{
    const request=factory.open(name);let absent=false,failed=false;
    request.onupgradeneeded=()=>{absent=true;request.transaction?.abort()};
    request.onerror=()=>absent?resolve(null):reject(request.error);
    request.onblocked=()=>{failed=true;reject(new Error('端末データを確認できません。別のQuizMake画面を閉じてください。'))};
    request.onsuccess=()=>{if(failed)request.result.close();else resolve(request.result)};
  });
  if(!db)return false;
  try{
    const names=Array.from(db.objectStoreNames).filter(name=>name!=='appRecordMeta');if(!names.length)return false;
    return await new Promise<boolean>((resolve,reject)=>{const tx=db.transaction(names),requests=names.map(name=>tx.objectStore(name).count());tx.oncomplete=()=>resolve(requests.some(request=>request.result>0));tx.onabort=()=>reject(tx.error)});
  }finally{db.close()}
}
async function hasData(factory:IDBFactory,session:AccountStorageSession){
  for(let i=0;i<session.storage.length;i++){
    const key=session.storage.key(i);if(!key)continue;
    if(key==='quiz-make-app-data-v1'||key==='quiz-make-creation-notes-v1'||/^(quizMake:plan:|quizMake:notes:|quizMake:category-note:|quizMake:weakness:|quizMake:sync:saved-backup:)/u.test(key)){
      const raw=session.storage.getItem(key);if(raw&&raw!=='[]'&&raw!=='{}'&&raw!=='null')return true;
    }
  }
  for(const base of ['quiz-make-app-data-v1','quiz-make-notes-v1','quiz-make-local-question-images-v1','quiz-make-backups'])if(await databaseHasRows(factory,session.databaseName(base)))return true;
  return Boolean(await readLatestAccountWork(factory,session));
}
export async function hasUnclaimedLegacyData(factory:IDBFactory,native:Storage,identity:LocalAccountIdentity){
  if(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY)||native.getItem(choiceKey(identity)))return false;
  return hasData(factory,new AccountStorageSession(native,{identity:null,namespace:'legacy',legacyUnclaimed:true}));
}
export function preserveUnclaimedLegacyData(native:Storage,identity:LocalAccountIdentity){
  const key=choiceKey(validateLocalAccountIdentity(identity));native.setItem(key,'preserved');if(native.getItem(key)!=='preserved')throw new Error('端末データの保管方針を保存できません。');
}
/** Explicit adoption establishes ownership in place. It never merges accounts,
 * rewrites answer IDs, claims a server stream, or alters an uncertain request. */
export async function adoptUnclaimedLegacyData(factory:IDBFactory,native:Storage,identity:LocalAccountIdentity,assertCurrent:()=>void|Promise<void>){
  const account=validateLocalAccountIdentity(identity);
  return withCoordinatedDataRead([],async()=>{
    await assertCurrent();
    const raw=native.getItem(ACCOUNT_VAULT_MANIFEST_KEY);
    if(raw){const manifest=JSON.parse(raw);if(manifest.version!==1||!sameLocalAccount(validateLocalAccountIdentity(manifest.legacyOwner),account))throw new Error('端末データは別のアカウントに所属しています。');return;}
    if(await readStoredAccountBinding(factory,'quiz-make-app-data-v1'))throw new Error('既存の同期接続があります。所有記録の確認が必要です。');
    const scoped=new AccountStorageSession(native,{identity:account,namespace:accountNamespace(account),legacyUnclaimed:true});
    if(await hasData(factory,scoped))throw new Error('このアカウントにも端末データがあります。両方の原本を保持しています。端末データを保管してアカウントを開いてください。');
    const guest=new AccountStorageSession(native,{identity:null,namespace:'legacy',legacyUnclaimed:true}),previous=await readLatestAccountWork(factory,guest);
    if(previous){const target=guest.databaseName('quiz-make-account-work-v1:'+accountNamespace(account));await saveAccountWork(factory,target,{...previous,id:crypto.randomUUID(),identity:account,resumed:false});}
    await assertCurrent();if(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY)!==null)throw new Error('端末データの所有記録が変わりました。原本は保持しています。');
    const next=JSON.stringify({version:1,legacyOwner:account});native.setItem(ACCOUNT_VAULT_MANIFEST_KEY,next);if(native.getItem(ACCOUNT_VAULT_MANIFEST_KEY)!==next)throw new Error('端末データの所有記録を保存できません。');
  },{requireCrossContext:true});
}
