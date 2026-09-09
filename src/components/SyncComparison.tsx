import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { computePayloadHash, downloadSyncData, exportQuizMakeData, getLastSyncState, getStoredSyncId, summarizeSyncPayload, type RemoteSyncRecord, type SyncPayload } from '../utils/syncService';
import { saveBackupPayload } from '../utils/backupRepository';

type Comparison = { local: SyncPayload; remote: RemoteSyncRecord | null; syncId: string };
export function SyncComparison({ syncId, disabled, onUpload, onDownload }: { syncId: string; disabled: boolean; onUpload: (payload?: SyncPayload, confirmedRemoteUpdatedAt?: string) => Promise<void>; onDownload: () => Promise<void> }) {
  const [value,setValue] = useState<Comparison | null>(null);
  const [pending,setPending] = useState<Comparison | null>(null);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const [attempt,setAttempt] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    if (disabled) { setValue(null); if (!lock.current) setLoading(false); return; }
    setLoading(true); setError(''); setValue(null);
    void Promise.all([exportQuizMakeData(),downloadSyncData(syncId)]).then(([local,remote]) => {
      if (!active) return;
      if (!remote.ok) throw new Error(remote.error);
      setValue({local,remote:remote.value,syncId});
    }).catch((reason) => { if(active) setError(reason instanceof Error ? reason.message : '同期状態を確認できません。'); }).finally(() => {if(active) setLoading(false);});
    return () => { active = false; };
  },[syncId,disabled,attempt]);
  const confirm = async () => {
    if (!pending || lock.current) return;
    lock.current = true; setLoading(true); setError('');
    try {
      if (!navigator.onLine || getStoredSyncId().trim() !== pending.syncId) throw new Error('接続状態が変わりました。同期状態を確認し直してください。');
      const [local,remote] = await Promise.all([exportQuizMakeData(), downloadSyncData(pending.syncId)]);
      if (!remote.ok) throw new Error(remote.error);
      if (computePayloadHash(local) !== computePayloadHash(pending.local) || remote.value?.updatedAt !== pending.remote?.updatedAt) throw new Error('確認中にデータが更新されました。同期状態を確認し直してください。');
      await saveBackupPayload(local,'before-sync');
      if (remote.value) await saveBackupPayload(remote.value.payload,'before-sync');
      await onUpload(local, remote.value?.updatedAt); setPending(null); setAttempt((n) => n+1);
    } catch(reason) { setError(reason instanceof Error ? reason.message : '同期を完了できませんでした。'); setPending(null); }
    finally {lock.current = false; setLoading(false);}
  };
  const same = value?.remote && computePayloadHash(value.local) === computePayloadHash(value.remote.payload);
  const syncNormally = async () => {
    if (!value || lock.current || disabled) return;
    lock.current = true; setLoading(true); setError('');
    try {
      const last = getLastSyncState();
      const localChanged = computePayloadHash(value.local) !== last.lastUploadHash;
      const remoteChanged = Boolean(value.remote && value.remote.updatedAt !== last.lastSyncAt);
      if (localChanged && remoteChanged && !same) {
        setError('両方に変更があります。残す内容を選んでください。');
        return;
      }
      if (same) { setAttempt((n) => n + 1); return; }
      if (remoteChanged) await onDownload();
      else await onUpload();
      setAttempt((n) => n + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '同期できませんでした。'); }
    finally { lock.current = false; setLoading(false); }
  };
  const local = value && summarizeSyncPayload(value.local);
  const remote = value?.remote && summarizeSyncPayload(value.remote.payload);
  return <section className="qm-sync-comparison">
    {loading ? <p role="status">同期状態を確認中…</p> : null}
    {error ? <p className="qm-wrong" role="alert">{error}<button disabled={loading} onClick={() => setAttempt((n) => n+1)}>再試行</button></p> : null}
    {value && local ? <>
      <p className="qm-sync-banner">{same ? '端末とクラウドは同じ内容です' : '端末とクラウドの内容を確認してください'}</p>
      <div className="qm-sync-columns">
        <div><h2>この端末</h2><div className="qm-sync-count"><strong>{local.problemSetCount}セット・{local.questionCount}問</strong><span>{local.folderCount}フォルダ</span></div></div>
        <div><h2>クラウド</h2><div className="qm-sync-count">{remote && value.remote ? <><strong>{remote.problemSetCount}セット・{remote.questionCount}問</strong><span>{new Date(value.remote.updatedAt).toLocaleString()}</span></> : '未登録'}</div></div>
      </div>
      <button className="sync-button sync-button--primary qm-sync-main" disabled={disabled || loading} onClick={() => void syncNormally()}>同期する</button>
      {!same ? <div className="sync-transfer-actions">
        <button className="sync-button sync-button--primary" disabled={disabled || loading} onClick={() => setPending(value)}>端末 → クラウドに同期</button>
        {remote ? <button className="sync-button sync-button--secondary" disabled={disabled || loading} onClick={() => void onDownload()}>クラウド → 端末に読み込む</button> : null}
      </div> : null}
    </> : null}
    <ConfirmDialog fullPage open={Boolean(pending)} title="端末の内容でクラウドを置き換えますか？" message={pending ? `残す内容：端末の${summarizeSyncPayload(pending.local).questionCount}問\n上書きする側：クラウド${pending.remote ? `（${new Date(pending.remote.updatedAt).toLocaleString()}）` : '（未登録）'}\n\n両方の復元用バックアップを作成・読み戻し確認してから実行します。` : ''} confirmLabel={loading ? '処理中…' : 'バックアップしてクラウドを置き換える'} busy={loading} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
  </section>;
}
