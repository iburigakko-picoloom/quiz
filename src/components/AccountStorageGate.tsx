import { useEffect, useRef, useState, type ReactNode } from 'react';
import { activateAccountStorage, sameLocalAccount, type AccountStorageSession, type LocalAccountIdentity } from '../utils/accountStorage';
import { initializeAccountStorage } from '../utils/accountStorageBootstrap';
import { cloudAuthStorageKey, getCachedCloudAccountIdentity, localIdentityForCloudSession, onCloudAuthStateChange, sendMagicLink } from '../utils/cloudService';
import { accountWorkDatabase, approveAccountWorkReload, captureAccountWork, flushAccountWork, readLatestAccountWork, restoreAccountWork, saveAccountWork, type AccountWorkSnapshot } from '../utils/accountWork';
import { waitForLocalPersistence } from '../utils/syncService';
import { getActiveProtectedWorkReason } from '../utils/protectedWork';
import './AccountStorageGate.css';
let boot: Promise<AccountStorageSession> | undefined;
function bootStorage() { return boot ??= initializeAccountStorage(getCachedCloudAccountIdentity()); }
type State = 'loading' | 'ready' | 'switching' | 'failed' | 'resume';
export function AccountStorageGate({ children }: { children: ReactNode }) {
  const [state,setState]=useState<State>('loading'),[message,setMessage]=useState('端末データを確認しています…');
  const [snapshot,setSnapshot]=useState<AccountWorkSnapshot|null>(null),[email,setEmail]=useState('');
  const owner=useRef<AccountStorageSession|null>(null),container=useRef<HTMLDivElement>(null),switching=useRef(false);
  const mounted=useRef(false),sequence=useRef(0);
  const checkpointDatabase=useRef('');
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
        if(switching.current){sequence.current++;session.resumeNetwork(current??null);switching.current=false;delete document.documentElement.dataset.quizAccountFenced;if(container.current){container.current.hidden=false;container.current.inert=false;}setState('ready');}
        return;
      }
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
      if(event==='INITIAL_SESSION'&&!session){try{if(getCachedCloudAccountIdentity())return;}catch{/* Fail closed in change. */}}
      change(localIdentityForCloudSession(session));
    });
    const storage=(event:StorageEvent)=>{if(event.key===null||event.key===cloudAuthStorageKey)change();};window.addEventListener('storage',storage);
    void bootStorage().then(async session=>{
      if(cancelled)return;
      if(!sameLocalAccount(session.identity,getCachedCloudAccountIdentity())){window.location.reload();return;}
      activateAccountStorage(session);owner.current=session;
      const previous=typeof indexedDB==='undefined'?null:await readLatestAccountWork(indexedDB,session);
      if(cancelled)return;
      if(previous){setSnapshot(previous);setState('resume');setMessage('このアカウントで編集中だった作業の控えがあります。');}
      else setState('ready');
    }).catch(()=>{if(!cancelled){setState('failed');setMessage('端末データの所有記録を確認できません。元のデータは保持しています。画面を開き直して再試行してください。');}});
    return()=>{cancelled=true;unsubscribe();window.removeEventListener('storage',storage);};
  },[]);
  const resume=async(restore:boolean)=>{
    const session=owner.current;if(!session||!snapshot)return;
    try{await saveAccountWork(indexedDB,accountWorkDatabase(session),{...snapshot,resumed:true});if(restore)restoreAccountWork(snapshot,session);setSnapshot(null);setState('ready');}catch{setMessage('作業の控えを読み込めません。原本は保持しています。');}
  };
  if(state==='ready')mounted.current=true;
  return <>
    <div ref={container} hidden={state!=='ready'} inert={state!=='ready'}>{mounted.current?children:null}</div>
    {state!=='ready'?<main className="account-storage-gate" aria-live="polite"><h1>{state==='resume'?'前の作業を再開':state==='failed'?'端末データを保持しています':'アカウントを確認'}</h1><p>{message}</p>
      {state==='resume'?<><button onClick={()=>void resume(true)}>作業を再開する</button><button onClick={()=>void resume(false)}>控えを残してホームへ</button></>:null}
      {state==='failed'&&switching.current?<><button onClick={()=>{setState('switching');void finish();}}>保存を再試行</button><label>前のアカウントのメールアドレス<input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"/></label><button disabled={!email.trim()} onClick={()=>void sendMagicLink(email.trim()).then(()=>setMessage('ログイン用リンクを送信しました。メールから前のアカウントへ戻ってください。')).catch(()=>setMessage('ログイン用リンクを送信できませんでした。通信状態を確認してください。'))}>ログイン用リンクを送る</button></>:null}
      {state==='failed'&&!switching.current?<button onClick={()=>window.location.reload()}>画面を開き直す</button>:null}
    </main>:null}
  </>;
}
