import { useEffect, useRef, useState, type ReactNode } from 'react';
import { activateAccountStorage, AccountStorageSession, accountGenerationKey, accountNamespace, readAccountGeneration, sameLocalAccount, type LocalAccountIdentity } from '../utils/accountStorage';
import { initializeAccountStorage } from '../utils/accountStorageBootstrap';
import { cloudAuthStorageKey, getCachedCloudAccountIdentity, getCloudAccessToken, localIdentityForCloudSession, onCloudAuthStateChange, sendMagicLink } from '../utils/cloudService';
import { accountWorkDatabase, approveAccountWorkReload, captureAccountWork, flushAccountWork, isAccountWorkReloadApproved, readLatestAccountWork, restoreAccountWork, saveAccountWork, type AccountWorkSnapshot } from '../utils/accountWork';
import { adoptUnclaimedLegacyData, hasUnclaimedLegacyData, preserveUnclaimedLegacyData } from '../utils/accountLegacyAdoption';
import { requestAccountSyncConnection } from '../utils/accountSync';
import { waitForLocalPersistence } from '../utils/syncService';
import { getActiveProtectedWorkReason } from '../utils/protectedWork';
import './AccountStorageGate.css';
let boot: Promise<AccountStorageSession> | undefined;
function bootStorage() { return boot ??= initializeAccountStorage(getCachedCloudAccountIdentity()); }
type State = 'loading' | 'ready' | 'switching' | 'failed' | 'resume' | 'legacy' | 'generation';
export function AccountStorageGate({ children }: { children: ReactNode }) {
  const [state,setState]=useState<State>('loading'),[message,setMessage]=useState('端末データを確認しています…');
  const [snapshot,setSnapshot]=useState<AccountWorkSnapshot|null>(null),[email,setEmail]=useState('');
  const owner=useRef<AccountStorageSession|null>(null),container=useRef<HTMLDivElement>(null),switching=useRef(false);
  const mounted=useRef(false),sequence=useRef(0);
  const checkpointDatabase=useRef('');
  const openSession=async(session:AccountStorageSession)=>{
    activateAccountStorage(session);
    const previous=typeof indexedDB==='undefined'?null:await readLatestAccountWork(indexedDB,session);
    if(previous){setSnapshot(previous);setState('resume');setMessage('このアカウントで編集中だった作業の控えがあります。');}else setState('ready');
  };
  const finish=async()=>{
    const attempt=sequence.current;
    try {
      await flushAccountWork();
      const saved=await waitForLocalPersistence();
      if(attempt!==sequence.current)return;
      if (!saved.ok) throw new Error('前のアカウントの保存が完了していないため、切り替えを保留しています。入力はこの画面に保持しています。');
      const session=owner.current; if (!session) throw new Error('端末データの所有記録を確認できません。');
      const reason=getActiveProtectedWorkReason();
      if (reason && reason!=='sync' && reason!=='library') await saveAccountWork(indexedDB,checkpointDatabase.current,captureAccountWork(session));
      if(attempt!==sequence.current)return;
      session.invalidate();
      approveAccountWorkReload();
      window.location.reload();
    } catch { if(attempt===sequence.current){setState('failed');setMessage('前のアカウントの作業を保存できないため、画面の切替を保留しています。元の入力はこの画面に保持しています。前のアカウントへログインして作業に戻るか、保存を再試行してください。');} }
  };
  useEffect(()=>{
    let cancelled=false;
    const change=(identity?:LocalAccountIdentity|null)=>{
      const session=owner.current;if (!session) return;
      let current=identity;try{if(current===undefined)current=getCachedCloudAccountIdentity();}catch{current=null;}
      if (sameLocalAccount(session.identity,current??null)) {
        if(session.identity&&readAccountGeneration(globalThis.localStorage,session.identity)!==session.generation){setState('generation');setMessage('統合後の保存先に切り替わっています。元の入力を控えてから開き直してください。');return;}
        if(switching.current){sequence.current++;session.resumeNetwork(current??null);switching.current=false;delete document.documentElement.dataset.quizAccountFenced;if(container.current){container.current.hidden=false;container.current.inert=false;}setState('ready');window.setTimeout(()=>requestAccountSyncConnection(),0);}
        return;
      }
      if(!mounted.current){window.location.reload();return;}
      if(switching.current)return;
      checkpointDatabase.current=accountWorkDatabase(session);
      // Hide synchronously, before another frame or an asynchronous Auth call.
      if(container.current){container.current.hidden=true;container.current.inert=true;}
      document.documentElement.dataset.quizAccountFenced='true';
      session.fenceNetwork();switching.current=true;sequence.current++;setState('switching');setMessage('前のアカウントの作業を保管しています…');
      // Supabase's callback holds its Auth lock. Never await work inside it.
      window.setTimeout(()=>void finish(),0);
    };
    const unsubscribe=onCloudAuthStateChange((event,session)=>{
      // The native cache remains available during offline token refresh. A null
      // INITIAL_SESSION must not turn an offline account into local-only data.
      if(event!=='SIGNED_OUT'&&!session){try{const cached=getCachedCloudAccountIdentity();if(cached&&(!owner.current||sameLocalAccount(owner.current.identity,cached)))return;}catch{/* Fail closed in change. */}}
      change(localIdentityForCloudSession(session));
    });
    const storage=(event:StorageEvent)=>{
      const session=owner.current;
      if(session?.identity&&(event.key===null||event.key===accountGenerationKey(session.identity))&&readAccountGeneration(globalThis.localStorage,session.identity)!==session.generation){
        if(container.current){container.current.hidden=true;container.current.inert=true;}session.fenceNetwork();
        if(getActiveProtectedWorkReason()){setState('generation');setMessage('別の画面でデータが統合されました。編集中の入力はこの画面に保持しています。作業を控えてから新しい保存先を開いてください。');}
        else window.location.reload();return;
      }
      if(event.key===null||event.key===cloudAuthStorageKey)change();
    };window.addEventListener('storage',storage);
    void bootStorage().then(async session=>{
      if(cancelled)return;
      if(!sameLocalAccount(session.identity,getCachedCloudAccountIdentity())){window.location.reload();return;}
      owner.current=session;
      if(session.identity&&session.legacyUnclaimed&&await hasUnclaimedLegacyData(indexedDB,globalThis.localStorage,session.identity)){
        if(cancelled)return;setState('legacy');setMessage('ログイン前の端末データがあります。このアカウントへ引き継ぐか、端末に保管したままアカウントを開くか選んでください。回答・画像・作業の控えを保持します。');return;
      }
      if(cancelled)return;
      await openSession(session);
    }).catch(()=>{if(!cancelled){setState('failed');setMessage('端末データの所有記録を確認できません。元のデータは保持しています。画面を開き直して再試行してください。');}});
    const beforeUnload=(event:BeforeUnloadEvent)=>{if(switching.current&&!isAccountWorkReloadApproved()){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
    return()=>{cancelled=true;unsubscribe();window.removeEventListener('storage',storage);window.removeEventListener('beforeunload',beforeUnload);};
  },[]);
  const legacyChoice=async(adopt:boolean)=>{
    const session=owner.current,identity=session?.identity;if(!session||!identity)return;
    setState('loading');
    try{
      if(!sameLocalAccount(identity,getCachedCloudAccountIdentity()))throw new Error('ログイン中のアカウントが変わりました。画面を開き直してください。');
      if(adopt){
        const access=await getCloudAccessToken();if(!access.ok||access.userId!==identity.userId)throw new Error('ログインを確認できません。接続を確認して再試行してください。');
        await adoptUnclaimedLegacyData(indexedDB,globalThis.localStorage,identity,()=>{if(!sameLocalAccount(identity,getCachedCloudAccountIdentity()))throw new Error('ログイン中のアカウントが変わりました。原本を保持しています。');});
        window.location.reload();
      }else{preserveUnclaimedLegacyData(globalThis.localStorage,identity);await openSession(session);}
    }catch(error){setState('legacy');setMessage(error instanceof Error?error.message:'端末データを確認できません。原本を保持しています。');}
  };
  const resume=async(restore:boolean)=>{
    const session=owner.current;if(!session||!snapshot)return;
    try{await saveAccountWork(indexedDB,accountWorkDatabase(session),{...snapshot,resumed:true});if(restore)restoreAccountWork(snapshot,session);setSnapshot(null);setState('ready');}catch{setMessage('作業の控えを読み込めません。原本は保持しています。');}
  };
  const reopenGeneration=async()=>{
    const previous=owner.current;if(!previous?.identity||!sameLocalAccount(previous.identity,getCachedCloudAccountIdentity()))return;
    try{const next=new AccountStorageSession(globalThis.localStorage,{identity:previous.identity,namespace:accountNamespace(previous.identity),legacyUnclaimed:false});
      const {readUnionMigrations,previewUnionMigration}=await import('../utils/accountUnionJournal'),{remapUnionWork}=await import('../utils/accountUnionWork');
      const migrations=await readUnionMigrations(indexedDB,globalThis.localStorage,previous.identity),chain=[];let generation=next.generation;
      while(generation!==previous.generation){const migration=migrations.find(row=>row.generation===generation);if(!migration||chain.length>=migrations.length)throw new Error('移行の由来を確認できません。');chain.unshift(migration);generation=migration.previousGeneration;}
      const work=captureAccountWork(previous);let recovered=work.work;for(const migration of chain)recovered=remapUnionWork(recovered,previewUnionMigration(migration).aliases);
      if(!sameLocalAccount(previous.identity,getCachedCloudAccountIdentity()))throw new Error('アカウントが変わりました。');
      await saveAccountWork(indexedDB,accountWorkDatabase(next),{...work,namespace:next.namespace,work:recovered});next.assertCurrent();approveAccountWorkReload();window.location.reload();
    }catch{setMessage('入力の控えを保存できませんでした。この画面の入力と元の保存領域を保持しています。');}
  };
  if(state==='ready')mounted.current=true;
  return <>
    <div ref={container} hidden={state!=='ready'} inert={state!=='ready'}>{mounted.current?children:null}</div>
    {state!=='ready'?<main className="account-storage-gate" aria-live="polite"><h1>{state==='resume'?'前の作業を再開':state==='failed'?'端末データを保持しています':'アカウントを確認'}</h1><p>{message}</p>
      {state==='resume'?<><button onClick={()=>void resume(true)}>作業を再開する</button><button onClick={()=>void resume(false)}>控えを残してホームへ</button></>:null}
      {state==='legacy'?<><button onClick={()=>void legacyChoice(true)}>このアカウントで使う</button><button onClick={()=>void legacyChoice(false)}>端末データを保管してアカウントを開く</button></>:null}
      {state==='generation'?<button onClick={()=>void reopenGeneration()}>作業を保管して開き直す</button>:null}
      {state==='failed'&&switching.current?<><button onClick={()=>{setState('switching');void finish();}}>保存を再試行</button><label>前のアカウントのメールアドレス<input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"/></label><button disabled={!email.trim()} onClick={()=>void sendMagicLink(email.trim()).then(()=>setMessage('ログイン用リンクを送信しました。メールから前のアカウントへ戻ってください。')).catch(()=>setMessage('ログイン用リンクを送信できませんでした。通信状態を確認してください。'))}>ログイン用リンクを送る</button></>:null}
      {state==='failed'&&switching.current?<><a href={window.location.href} target="_blank" rel="noopener noreferrer">別のタブでログイン</a><p>LINEで戻る場合は、新しいタブの設定から前のアカウントへログインしてください。この画面の入力は保持されます。</p></>:null}
      {state==='failed'&&!switching.current?<button onClick={()=>window.location.reload()}>画面を開き直す</button>:null}
    </main>:null}
  </>;
}
