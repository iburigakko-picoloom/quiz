import { useEffect, useState } from 'react';
import { openAppDb } from '../storage';
import { getRemoteSyncConfig } from '../utils/syncService';
import { chooseWholeConflict, readWholeMeta, WHOLE_EVENT, type WholeConflict, type WholeSummary } from '../utils/wholeSyncStorage';
import { withCoordinatedDataRead } from '../utils/dataCoordination';
import { requestSyncRetry } from '../utils/syncRequest';
import { readSyncDevice } from '../utils/syncDevice';

const counts=(value:WholeSummary)=>`問題集 ${value.sets.toLocaleString()}冊 ・ 問題 ${value.questions.toLocaleString()}問 ・ 回答 ${value.answers.toLocaleString()}回`;
export function WholeConflictPanel({syncId,accountId,open,onOpenChange,onOpenBackups,onBusyChange}:{syncId:string;accountId:string;open:boolean;onOpenChange:(value:boolean)=>void;onOpenBackups?:()=>void;onBusyChange?:(value:boolean)=>void}){
  const [conflict,setConflict]=useState<WholeConflict>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let stopped=false,reading=false;
    const refresh=async()=>{if(reading)return;reading=true;try{const config=getRemoteSyncConfig();if(!config)throw new Error('同期先を確認してください。');const value=await readWholeMeta<WholeConflict>(await openAppDb(),'wholeConflict',{project:new URL(config.url).origin,userId:accountId,syncId});if(!stopped)setConflict(value)}catch{if(!stopped)setError('保存済みの確認内容を読み込めません。両方のデータを保持しています。')}finally{reading=false}};
    void refresh();const timer=window.setInterval(()=>void refresh(),5000);window.addEventListener(WHOLE_EVENT,refresh);
    return()=>{stopped=true;window.clearInterval(timer);window.removeEventListener(WHOLE_EVENT,refresh)};
  },[syncId,accountId]);
  const choose=async(choice:'local'|'remote')=>{
    if(!conflict||busy)return;setBusy(true);onBusyChange?.(true);setError('');
    try{const config=getRemoteSyncConfig();if(!config)throw new Error();const db=await openAppDb();if(new URL(config.url).origin!==conflict.connection.project||conflict.connection.userId!==accountId||conflict.connection.syncId!==syncId)throw new Error();await withCoordinatedDataRead(['app','notes'],()=>chooseWholeConflict(db,conflict.connection,conflict,choice),{requireCrossContext:true});onOpenChange(false);requestSyncRetry(syncId)}catch{setError('確認中にデータが変わったか、選択を保存できませんでした。両方を保持しています。最新の内容を再確認してください。')}finally{setBusy(false);onBusyChange?.(false)}
  };
  const select=(choice:'local'|'remote')=>{void choose(choice)};
  if(!conflict)return error?<p role="alert">{error}</p>:null;
  if(conflict.choice)return <p role="status">選択した全体データの反映を待っています。両方の原本を保持しています。</p>;
  const remoteDevice=readSyncDevice(conflict.device),localDevice=readSyncDevice(conflict.localDevice);
  return <section className="sync-section whole-conflict" aria-labelledby="whole-conflict-title"><h2 id="whole-conflict-title">両方で変更されています</h2>
    <p>クラウドとこの端末のどちらを使うか、全体で一度選びます。選ばなかった全体データは、画像・PDFを含めこの端末の復旧コピーに保存します。</p>
    {!open?<button className="sync-button sync-button--primary" onClick={()=>onOpenChange(true)}>内容を確認して選ぶ</button>:<>
      <div className="whole-conflict__option"><h3>クラウドのデータ（{remoteDevice.name}）</h3><p>{counts(conflict.remote)}</p><p>更新日時：{conflict.savedAt?new Date(conflict.savedAt).toLocaleString('ja-JP'):'不明'}<br/>端末ID：{remoteDevice.id??'記録なし（旧端末）'}</p><button className="sync-button sync-button--primary" disabled={busy} onClick={()=>select('remote')}>クラウドのデータを使う</button></div>
      <div className="whole-conflict__option"><h3>この端末のデータ</h3><p>{counts(conflict.local)}</p><p>端末名：{localDevice.name}<br/>更新日時：{conflict.localSavedAt?new Date(conflict.localSavedAt).toLocaleString('ja-JP'):'不明'}<br/>端末ID：{localDevice.id??'記録なし（旧端末）'}</p><p>この端末で保存した教材・回答・計画・設定をクラウドへ反映します。</p><button className="sync-button" disabled={busy} onClick={()=>select('local')}>この端末のデータを使う</button></div>
      <p>保存日時だけで自動選択しません。容量が不足する場合は入れ替えを止め、両方を保持します。</p><button className="sync-button" disabled={busy} onClick={()=>onOpenChange(false)}>今は選ばず閉じる</button>
    </>}{onOpenBackups?<button className="sync-button" disabled={busy} onClick={onOpenBackups}>復旧コピーを見る</button>:null}{error?<p role="alert">{error}</p>:null}
  </section>;
}
