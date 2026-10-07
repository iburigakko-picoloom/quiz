import {useEffect,useLayoutEffect,useState} from 'react';
import type {SyncScreenPage} from '../types';
import {BackButton} from '../components/BackButton';
import {SyncStatus} from '../components/SyncStatus';
import {LineLoginButton} from '../components/LineLoginButton';
import {LegacyWholeSyncNotice} from '../components/LegacyWholeSyncNotice';
import {WholeConflictPanel} from '../components/WholeConflictPanel';
import {WHOLE_SYNC_ROLLOUT_ENABLED} from '../utils/wholeSyncRollout';
import {onCloudSessionSnapshot,sendMagicLink} from '../utils/cloudService';
import {ACCOUNT_SYNC_EVENT,getAccountSyncState,requestAccountSyncConnection} from '../utils/accountSync';
import {getAutoSyncSettings,getLastSyncState,setAutoSyncEnabled} from '../utils/syncService';
import {setSyncInteractionProtected} from '../utils/syncInteraction';
import {SyncScreen as LegacySyncScreen} from './SyncScreen';
import './SyncScreen.css';
type Props={onBack:()=>void;onImported?:()=>Promise<void>;onProtectionChange?:(value:boolean)=>void;onOpenBackups?:()=>void;page?:SyncScreenPage;onNavigatePage?:(page:SyncScreenPage)=>void;onExitGuardChange?:(guard:(()=>boolean)|null)=>void};
const messages={connecting:'アカウントの保存先を確認しています。',offline:'オフラインです。変更は端末に保存し、接続後に同期します。',selection_required:'以前の保存先が複数あります。使う保存先を選んでください。ほかの保存先は残ります。',migration_required:'以前の端末データと保存先が異なるため同期を停止しています。両方のデータは保持しています。',legacy_connection:'以前の保存先を確認する必要があります。端末データは保持しています。',not_found:'以前の保存先の所有者を確認できません。端末データは保持しています。',deleted:'クラウドの保存先は削除されています。端末のデータを勝手に再送せず、保持しています。',unavailable:'アカウント同期の準備がまだできていません。学習データはこの端末に保存されています。',failed:'アカウントの保存先を確認できませんでした。端末データは保持しています。',paused:'この端末の同期を休止しています。端末データを削除した後は、クラウドから戻すかを確認できます。'};
export function AccountSyncScreen({onBack,onImported,onProtectionChange,onOpenBackups,onExitGuardChange,page,onNavigatePage}:Props){
  const [state,setState]=useState(getAccountSyncState),[last,setLast]=useState(getLastSyncState),[account,setAccount]=useState<{id:string;label:string}|null>(null);
  const [email,setEmail]=useState(''),[loginBusy,setLoginBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[review,setReview]=useState(false),[busy,setBusy]=useState(false),[legacy,setLegacy]=useState(page==='recovery');
  const [toolsPage,setToolsPage]=useState<SyncScreenPage>();
  useEffect(()=>{const stop=onCloudSessionSnapshot(s=>setAccount(s?.user&&!s.user.is_anonymous?{id:s.user.id,label:s.user.email??'ログイン中のアカウント'}:null));const update=()=>{setState(getAccountSyncState());setLast(getLastSyncState())};window.addEventListener(ACCOUNT_SYNC_EVENT,update);window.addEventListener('quiz-make-sync-settings-change',update);return()=>{stop();window.removeEventListener(ACCOUNT_SYNC_EVENT,update);window.removeEventListener('quiz-make-sync-settings-change',update)}},[]);
  useLayoutEffect(()=>{const protectedWork=busy||loginBusy||review;setSyncInteractionProtected(protectedWork);onProtectionChange?.(protectedWork);onExitGuardChange?.(()=>!protectedWork);return()=>{setSyncInteractionProtected(false);onProtectionChange?.(false);onExitGuardChange?.(null)}},[busy,loginBusy,review,onProtectionChange,onExitGuardChange]);
  if(legacy||page||toolsPage)return <LegacySyncScreen page={page??toolsPage??'recovery'} onNavigatePage={next=>{if(onNavigatePage)onNavigatePage(next);else setToolsPage(next)}} onBack={()=>{if(page)onBack();else{setLegacy(false);setToolsPage(undefined);requestAccountSyncConnection()}}} onImported={onImported} onOpenBackups={onOpenBackups} onProtectionChange={onProtectionChange} onExitGuardChange={onExitGuardChange}/>;
  const id=state.syncId??getAutoSyncSettings().syncId;
  return <main className="sync-screen sync-screen--simple sync-screen--account"><header className="sync-screen__header"><BackButton className="sync-screen__back" onClick={onBack}/><div className="sync-screen__header-text"><h1>同期</h1></div></header><div className="sync-screen__body">
    <section className="sync-section"><div className="sync-account-summary"><span className="sync-account-avatar" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="13" r="7"/><path d="M7 34c0-8 6-13 13-13s13 5 13 13Z"/></svg></span><div><strong>アカウント</strong><span>{account?.label??'ログインして学習を引き継ぐ'}</span></div></div><p>同じアカウントの端末間で、保存済みの学習データを自動で同期します。</p>
    {state.phase==='signed_out'?<><LineLoginButton/><label className="sync-label">メールアドレス<input className="sync-input" type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><button className="sync-button sync-button--primary" disabled={loginBusy||!email.trim()} onClick={()=>{setLoginBusy(true);setError('');void sendMagicLink(email.trim()).then(()=>setMessage('ログイン用リンクを送りました。メールからログインしてください。')).catch(()=>setError('リンクを送れませんでした。接続を確認してください。')).finally(()=>setLoginBusy(false))}}>ログイン用リンクを送る</button></>:state.phase==='ready'&&account?<><SyncStatus syncId={id} accountId={account.id} recordEnabled autoEnabled lastState={last} disabled={busy||review} onLogin={()=>requestAccountSyncConnection()} choiceOpen={review} onChooseSource={()=>setReview(true)}/>{WHOLE_SYNC_ROLLOUT_ENABLED?<WholeConflictPanel syncId={id} accountId={account.id} open={review} onOpenChange={setReview} onOpenBackups={onOpenBackups} onBusyChange={setBusy}/>:<LegacyWholeSyncNotice syncId={id} accountId={account.id} onOpenBackups={onOpenBackups}/>}</>:<><p role="status">{messages[state.phase as keyof typeof messages]}</p>
      {state.phase==='selection_required'?state.choices?.map((choice,index)=><button className="sync-button" key={choice.syncId} onClick={()=>requestAccountSyncConnection(choice.syncId)}>保存先 {index+1}（最終保存 {new Date(choice.updatedAt).toLocaleString('ja-JP')}）を使う</button>):null}
      {['failed','offline','unavailable'].includes(state.phase)?<button className="sync-button" onClick={()=>requestAccountSyncConnection()}>接続を再確認</button>:null}
      {state.phase==='paused'?<button className="sync-button" onClick={()=>{const result=setAutoSyncEnabled(true);if(!result.ok)setError(result.error)}}>クラウドとの同期を再開</button>:null}
      {['legacy_connection','not_found'].includes(state.phase)?<button className="sync-button" onClick={()=>setLegacy(true)}>旧データの復旧を確認</button>:null}
    </>}
    {message?<p role="status">{message}</p>:null}{error?<p role="alert">{error}</p>:null}</section>
    <button type="button" className="sync-subpage-row" disabled={busy||review||loginBusy} onClick={()=>{if(onNavigatePage)onNavigatePage('settings');else setToolsPage('settings')}}>詳細設定<span aria-hidden="true">›</span></button>
    {onOpenBackups?<button className="sync-subpage-row" disabled={busy||review||loginBusy} onClick={onOpenBackups}>バックアップ・復旧<span aria-hidden="true">›</span></button>:null}
  </div></main>;
}
