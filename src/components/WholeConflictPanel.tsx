import { useEffect, useState } from 'react';
import { openAppDb } from '../storage';
import { getRemoteSyncConfig } from '../utils/syncService';
import { chooseWholeConflict, readWholeMeta, WHOLE_EVENT, type WholeConflict, type WholeSummary } from '../utils/wholeSyncStorage';
import { withCoordinatedDataRead } from '../utils/dataCoordination';
import { requestSyncRetry } from '../utils/syncRequest';
import { readSyncDevice } from '../utils/syncDevice';
import { SyncDataChoice } from './SyncDataChoice';

const contents = (value: WholeSummary) => `問題集 ${value.sets.toLocaleString('ja-JP')}冊・回答 ${value.answers.toLocaleString('ja-JP')}回・画像 ${value.images.toLocaleString('ja-JP')}件・PDF ${value.pdfs.toLocaleString('ja-JP')}件`;
const savedTime = (value?: string | null) => value ? new Date(value).toLocaleString('ja-JP', {dateStyle:'short',timeStyle:'short'}) : '保存日時不明';
export function WholeConflictPanel({syncId,accountId,open,onOpenChange,onOpenBackups,onBusyChange}:{syncId:string;accountId:string;open:boolean;onOpenChange:(value:boolean)=>void;onOpenBackups?:()=>void;onBusyChange?:(value:boolean)=>void}) {
  const [conflict,setConflict] = useState<WholeConflict>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [selection,setSelection] = useState<'local'|'remote'>('local');
  useEffect(() => {
    let stopped = false, reading = false;
    setConflict(undefined); setError('');
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const config = getRemoteSyncConfig();
        if (!config) throw new Error();
        const value = await readWholeMeta<WholeConflict>(await openAppDb(), 'wholeConflict', {project:new URL(config.url).origin,userId:accountId,syncId});
        if (!stopped) { setConflict(value); setError(''); }
      } catch { if (!stopped) setError('保存済みの確認内容を読み込めません。両方のデータを保持しています。'); }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener(WHOLE_EVENT, refresh);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener(WHOLE_EVENT,refresh); };
  }, [syncId,accountId]);
  useEffect(() => { setSelection('local'); }, [syncId,accountId,conflict?.revision,conflict?.generation,conflict?.localDigest,conflict?.remoteDigest]);
  const choose = async () => {
    if (!conflict || busy) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      const config = getRemoteSyncConfig();
      if (!config) throw new Error();
      const db = await openAppDb();
      if (new URL(config.url).origin !== conflict.connection.project || conflict.connection.userId !== accountId || conflict.connection.syncId !== syncId) throw new Error();
      await withCoordinatedDataRead(['app','notes'], () => chooseWholeConflict(db,conflict.connection,conflict,selection), {requireCrossContext:true});
      onOpenChange(false); requestSyncRetry(syncId);
    } catch { setError('確認中にデータが変わったか、選択を保存できませんでした。両方を保持しています。最新の内容を再確認してください。'); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  if (!conflict) return error ? <p role="alert">{error}</p> : null;
  if (conflict.choice) return <p role="status">選択した全体データの反映を待っています。両方の原本を保持しています。</p>;
  const remoteDevice = readSyncDevice(conflict.device), localDevice = readSyncDevice(conflict.localDevice);
  return <section className="sync-section whole-conflict" aria-labelledby="whole-conflict-title">
    <h2 id="whole-conflict-title">使うデータを選択</h2><p>両方の端末で変更があります</p>
    {!open ? <button type="button" className="sync-button sync-button--primary" onClick={() => onOpenChange(true)}>内容を確認して選ぶ</button> : <>
      <fieldset className="sync-data-choices" disabled={busy}><legend className="sync-choice-hidden">使う全体データ</legend>
        <SyncDataChoice name="whole-sync-source" value="local" title={localDevice.name} timestamp={savedTime(conflict.localSavedAt)} questionCount={conflict.local.questions} note={contents(conflict.local)} checked={selection==='local'} onChange={() => setSelection('local')} />
        <SyncDataChoice name="whole-sync-source" value="remote" title={`クラウド・${remoteDevice.name}`} timestamp={savedTime(conflict.savedAt)} questionCount={conflict.remote.questions} note={contents(conflict.remote)} checked={selection==='remote'} onChange={() => setSelection('remote')} />
      </fieldset>
      <button type="button" className="sync-button sync-button--primary sync-selection-submit" disabled={busy} onClick={() => void choose()}>{busy ? '保存中…' : 'このデータを使う'}</button>
      <p className="sync-selection-note">選ばなかったデータは<br/>画像・PDFを含め復旧用に保存</p>
      <button type="button" className="sync-button" disabled={busy} onClick={() => onOpenChange(false)}>今は選ばず閉じる</button>
    </>}
    {onOpenBackups ? <button type="button" className="sync-button" disabled={busy} onClick={onOpenBackups}>バックアップ・復旧</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
