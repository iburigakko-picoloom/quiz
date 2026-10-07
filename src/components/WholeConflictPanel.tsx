import { useEffect, useRef, useState } from 'react';
import { openAppDb } from '../storage';
import { getRemoteSyncConfig } from '../utils/syncService';
import { chooseWholeConflict, readWholeMeta, WHOLE_EVENT, type WholeConflict, type WholeSummary } from '../utils/wholeSyncStorage';
import { withCoordinatedDataRead } from '../utils/dataCoordination';
import { requestSyncRetry } from '../utils/syncRequest';
import { readSyncDevice } from '../utils/syncDevice';
import { readSyncAttemptStatus, SYNC_ATTEMPT_EVENT, type SyncAttemptStatus } from '../utils/syncAttemptStatus';
import { syncFailureReason } from '../utils/syncStatusReason';
import { SyncDataChoice } from './SyncDataChoice';

const contents = (value: WholeSummary) => `問題集 ${value.sets.toLocaleString('ja-JP')}冊・回答 ${value.answers.toLocaleString('ja-JP')}回・画像 ${value.images.toLocaleString('ja-JP')}件・PDF ${value.pdfs.toLocaleString('ja-JP')}件`;
const savedTime = (value?: string | null) => value ? new Date(value).toLocaleString('ja-JP', {dateStyle:'short',timeStyle:'short'}) : '保存日時不明';
export function WholeConflictPanel({syncId,accountId,open,onOpenChange,onBusyChange}:{syncId:string;accountId:string;open:boolean;onOpenChange:(value:boolean)=>void;onOpenBackups?:()=>void;onBusyChange?:(value:boolean)=>void}) {
  const [conflict,setConflict] = useState<WholeConflict>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [selection,setSelection] = useState<'local'|'remote'>();
  const [attempt,setAttempt] = useState<SyncAttemptStatus|null>(null);
  const openChange = useRef(onOpenChange); openChange.current = onOpenChange;
  useEffect(() => {
    let stopped = false, reading = false;
    setConflict(undefined);setError('');setAttempt(null);
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const config = getRemoteSyncConfig();if (!config) throw new Error();
        const connection = {project:new URL(config.url).origin,userId:accountId,syncId};
        if(!stopped)setAttempt(readSyncAttemptStatus(connection));
        const value = await readWholeMeta<WholeConflict>(await openAppDb(),'wholeConflict',connection);
        if(!stopped){setConflict(value);setError('');}
      }catch{if(!stopped)setError('同期する内容を読み込めません。両方のデータを保持しています。');}
      finally{reading=false;}
    };
    void refresh();const timer=window.setInterval(()=>void refresh(),5000);
    window.addEventListener(WHOLE_EVENT,refresh);window.addEventListener(SYNC_ATTEMPT_EVENT,refresh);
    return()=>{stopped=true;window.clearInterval(timer);window.removeEventListener(WHOLE_EVENT,refresh);window.removeEventListener(SYNC_ATTEMPT_EVENT,refresh);};
  },[syncId,accountId]);
  useEffect(()=>{
    setSelection(conflict?.choice);
    if(conflict&&!conflict.choice)openChange.current(true);
    else if(!conflict)openChange.current(false);
  },[syncId,accountId,conflict?.revision,conflict?.generation,conflict?.localDigest,conflict?.remoteDigest,conflict?.choice]);
  const retry=()=>{setError('');onOpenChange(false);requestSyncRetry(syncId);};
  const choose=async()=>{
    if(!conflict||!selection||busy)return;
    setBusy(true);onBusyChange?.(true);setError('');
    try{
      const config=getRemoteSyncConfig();if(!config)throw new Error();
      const db=await openAppDb();
      if(new URL(config.url).origin!==conflict.connection.project||conflict.connection.userId!==accountId||conflict.connection.syncId!==syncId)throw new Error();
      await withCoordinatedDataRead(['app','notes'],()=>chooseWholeConflict(db,conflict.connection,conflict,selection,{preferSelected:true}),{requireCrossContext:true});
      onOpenChange(false);requestSyncRetry(syncId);
    }catch{setError('確認中にデータが変わったか、選択を保存できませんでした。両方を保持しています。最新の内容を選び直してください。');}
    finally{setBusy(false);onBusyChange?.(false);}
  };
  if(!conflict)return error?<p role="alert">{error}</p>:null;
  const failure=attempt?.lastFailure&&(attempt.phase==='failed'||attempt.phase==='paused'&&(attempt.pauseReason===attempt.lastFailure.code||open&&attempt.pauseReason==='protected_work'))?attempt.lastFailure:null;
  const failureMessage=error|| (failure ? syncFailureReason(failure) : '');
  if(conflict.choice&&!open&&failureMessage)return null;
  const remoteDevice=readSyncDevice(conflict.device),localDevice=readSyncDevice(conflict.localDevice);
  return <section className="sync-section whole-conflict" aria-labelledby="whole-conflict-title">
    <h2 id="whole-conflict-title">どちらで同期しますか？</h2>
    {open&&failureMessage?<p role="alert">{failureMessage}</p>:null}
    {conflict.choice&&!open ? <>
      <p role="status">{failureMessage ? '同期を完了できませんでした。両方の原本を保持しています。' : '選んだデータで同期しています。バックアップは自動で保存します。'}</p>
      {failureMessage ? <><p role="alert">{failureMessage}</p><button type="button" className="sync-button sync-button--primary" disabled={busy} onClick={retry}>再試行</button></> : null}
      <button type="button" className="sync-button" disabled={busy||attempt?.phase==='running'} onClick={()=>onOpenChange(true)}>選び直す</button>
    </> : !open ? <button type="button" className="sync-button sync-button--primary" onClick={()=>onOpenChange(true)}>同期する方を選ぶ</button> : <>
      <fieldset className="sync-data-choices" disabled={busy}><legend className="sync-choice-hidden">同期する全体データ</legend>
        <SyncDataChoice name="whole-sync-source" value="local" title="この端末" timestamp={savedTime(conflict.localSavedAt)} questionCount={conflict.local.questions} note={`${localDevice.name}・${contents(conflict.local)}`} checked={selection==='local'} onChange={()=>setSelection('local')}/>
        <SyncDataChoice name="whole-sync-source" value="remote" title="クラウド" timestamp={savedTime(conflict.savedAt)} questionCount={conflict.remote.questions} note={`${remoteDevice.name}・${contents(conflict.remote)}`} checked={selection==='remote'} onChange={()=>setSelection('remote')}/>
      </fieldset>
      <button type="button" className="sync-button sync-button--primary sync-selection-submit" disabled={busy||!selection} onClick={()=>void choose()}>{busy?'選択を保存中…':'このデータで同期'}</button>
      <p className="sync-selection-note">{failureMessage.includes('画像')?'画像情報が不足していても、原本を退避して同期します。':'選ばなかった原本は自動で退避します。'}</p>
      <button type="button" className="sync-button" disabled={busy} onClick={()=>onOpenChange(false)}>今は同期しない</button>
    </>}
  </section>;
}
