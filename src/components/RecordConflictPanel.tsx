import { useEffect, useState } from 'react';
import { getCloudAccessToken } from '../utils/cloudService';
import { withCoordinatedDataMutation } from '../utils/dataCoordination';
import { replayLocalStorageProjections } from '../utils/localStorageRecords';
import { applyStagedRecordPull, readActiveRecordConflicts, type RecordConflict, type RecordConflictDecision } from '../utils/recordSyncPull';
import { getRemoteSyncConfig, getStoredSyncId, waitForLocalPersistence } from '../utils/syncService';
import { openAppDb } from '../storage';

function describe(raw: string | null): string {
  if (raw === null) return '削除';
  try {
    const value = JSON.parse(raw);
    if (typeof value?.question === 'string') return value.question.slice(0,300);
    if (typeof value?.title === 'string') return value.title.slice(0,300);
    if (typeof value?.name === 'string') return value.name.slice(0,300);
    if (Array.isArray(value?.pages)) return `ノート ${value.pages.length}ページ・更新 ${String(value.updatedAt ?? '不明')}`;
    if (typeof value?.answeredCount === 'number') return `回答 ${value.answeredCount}回・正解 ${value.correctCount ?? 0}回`;
    return `保存データ ${raw.length}文字`;
  } catch { return `保存データ ${raw.length}文字`; }
}

export function RecordConflictPanel({syncId,accountId,onImported}:{syncId:string;accountId:string;onImported?:()=>Promise<void>}) {
  const [conflicts,setConflicts]=useState<RecordConflict[]>([]);
  const [choices,setChoices]=useState<Record<string,'local'|'remote'>>({});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const connection=()=>{
    const config=getRemoteSyncConfig();
    if(!config) throw new Error('同期先が設定されていません。');
    return {project:new URL(config.url).origin,userId:accountId,syncId};
  };
  useEffect(()=>{
    let stopped=false;
    const load=async()=>{
      try {const found=await readActiveRecordConflicts(await openAppDb(),connection());if(!stopped)setConflicts(found);}
      catch(error){if(!stopped)setError(error instanceof Error?error.message:'競合を読み込めませんでした。');}
    };
    void load();const interval=window.setInterval(()=>void load(),5000);
    return()=>{stopped=true;window.clearInterval(interval);};
  },[syncId,accountId]);
  if(!conflicts.length) return null;
  const resolve=async()=>{
    if(busy||conflicts.some(item=>!choices[item.key]))return;
    setBusy(true);setError('');
    try{
      if(getStoredSyncId()!==syncId)throw new Error('同期先が変わりました。');
      const access=await getCloudAccessToken();
      if(!access.ok||access.userId!==accountId)throw new Error('ログイン状態が変わりました。');
      const saved=await waitForLocalPersistence();if(!saved.ok)throw new Error(saved.error);
      const selected:RecordConflictDecision[]=conflicts.map(item=>({key:item.key,operationId:item.operationId!,remoteRevision:item.remote.revision,choice:choices[item.key]}));
      const applied=await withCoordinatedDataMutation(['app','notes'],async()=>{
        if(getStoredSyncId()!==syncId)throw new Error('同期先が変わりました。');
        const result=await applyStagedRecordPull(await openAppDb(),connection(),selected);
        if(result.applied)await replayLocalStorageProjections();
        return result;
      },{requireCrossContext:true});
      if(!applied.applied)throw new Error('競合内容が更新されました。もう一度確認してください。');
      setConflicts([]);setChoices({});
      await onImported?.();
    }catch(caught){setError(caught instanceof Error?caught.message:'競合を確定できませんでした。');}
    finally{setBusy(false);}
  };
  return <section className="sync-card" aria-label="競合する編集">
    <h2>同じデータへの編集を確認</h2>
    <p>両方の内容を端末に保存しています。各項目で使う内容を選んでください。選ばなかった内容も復旧用に残ります。</p>
    {conflicts.map(item=><fieldset key={item.key} disabled={busy}>
      <legend>{item.remote.collection}・{item.remote.id}</legend>
      <label><input type="radio" name={item.key} checked={choices[item.key]==='local'} onChange={()=>setChoices(current=>({...current,[item.key]:'local'}))}/>端末: {describe(item.local?.raw??null)}</label>
      <label><input type="radio" name={item.key} checked={choices[item.key]==='remote'} onChange={()=>setChoices(current=>({...current,[item.key]:'remote'}))}/>クラウド: {describe(item.remote.raw)}</label>
    </fieldset>)}
    {error?<p role="alert">{error}</p>:null}
    <button type="button" className="sync-button sync-button--primary" disabled={busy||conflicts.some(item=>!choices[item.key])} onClick={()=>void resolve()}>{busy?'確定中…':'選んだ内容を確定'}</button>
  </section>;
}
