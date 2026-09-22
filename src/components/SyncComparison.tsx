import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { computePayloadHash, downloadSyncData, exportQuizMakeData, getLastSyncState, getStoredSyncId, summarizeSyncPayload, type RemoteSyncRecord, type SyncPayload, type SyncPayloadSummary } from '../utils/syncService';
import { saveBackupPayload } from '../utils/backupRepository';
import { materialComparisonPayload } from '../utils/materialCloud';

type Comparison = { local: SyncPayload; remote: RemoteSyncRecord | null; syncId: string; same: boolean; localHash: string };
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
    void Promise.all([exportQuizMakeData(),downloadSyncData(syncId, { materialFiles: 'references' })]).then(async ([local,remote]) => {
      if (!active) return;
      if (!remote.ok) throw new Error(remote.error);
      const [localComparison, remoteComparison] = await Promise.all([
        materialComparisonPayload(local), remote.value ? materialComparisonPayload(remote.value.payload) : null,
      ]);
      if (!active) return;
      setValue({local,remote:remote.value,syncId,localHash:computePayloadHash(local),same:Boolean(remoteComparison && computePayloadHash(localComparison) === computePayloadHash(remoteComparison))});
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
  const same = value?.same ?? false;
  const syncNormally = async () => {
    if (!value || lock.current || disabled) return;
    lock.current = true; setLoading(true); setError('');
    try {
      const last = getLastSyncState();
      const localChanged = value.localHash !== last.lastUploadHash;
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
  const local = useMemo(() => value && summarizeSyncPayload(value.local), [value]);
  const remote = useMemo(() => value?.remote && summarizeSyncPayload(value.remote.payload), [value]);
  const last = getLastSyncState();
  const localChanged = Boolean(value && value.localHash !== last.lastUploadHash);
  const remoteChanged = Boolean(value?.remote && value.remote.updatedAt !== last.lastSyncAt);
  const state: SyncViewState = same ? 'same' : localChanged && remoteChanged ? 'conflict' : remoteChanged ? 'cloud' : 'local';
  return <section className="qm-sync-comparison" aria-label="同期の状態" aria-busy={loading || disabled}>
    {!value && (loading || !error) ? <p className="sync-overview-loading" role="status">{disabled ? '同期処理中…' : '同期状態を確認中…'}</p> : null}
    {error ? <div className="sync-overview-error" role="alert"><p>{error}</p><button className="sync-button sync-button--secondary" disabled={loading || disabled} onClick={() => setAttempt((n) => n+1)}>もう一度確認</button></div> : null}
    {!value && error ? <div className="sync-overview-choices">
      <p className="sync-help">新しい端末では、保存済みのクラウドデータを確認して取り込めます。クラウドは上書きしません。</p>
      <button type="button" className="sync-button sync-button--primary" disabled={loading || disabled} onClick={() => void onDownload()}>クラウドの保存データを確認・取り込む</button>
    </div> : null}
    {value && local ? <SyncComparisonView state={state} local={local} remote={remote || null} disabled={disabled || loading}
      onSync={() => void syncNormally()} onUpload={() => setPending(value)} onDownload={() => void onDownload()} /> : null}
    <ConfirmDialog fullPage open={Boolean(pending)} title="端末の内容でクラウドを置き換えますか？" message={pending ? `残す内容：端末の${local?.questionCount ?? 0}問\n上書きする側：クラウド${pending.remote ? `（${new Date(pending.remote.updatedAt).toLocaleString()}）` : '（未登録）'}\n\n両方の復元用バックアップを作成・読み戻し確認してから実行します。` : ''} confirmLabel={loading ? '処理中…' : 'バックアップしてクラウドを置き換える'} busy={loading} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
  </section>;
}

export type SyncViewState = 'same' | 'local' | 'cloud' | 'conflict';
/** Presentation only: this component cannot access or modify stored learning data. */
export function SyncComparisonView({ state, local, remote, disabled, onSync, onUpload, onDownload }: {
  state: SyncViewState; local: SyncPayloadSummary; remote: SyncPayloadSummary | null; disabled: boolean;
  onSync: () => void; onUpload: () => void; onDownload: () => void;
}) {
  const conflict = state === 'conflict';
  const title = state === 'same' ? '同期済み' : conflict ? 'どちらの内容を使いますか？' : state === 'cloud' ? 'クラウドに更新があります' : remote ? 'この端末の変更を保存できます' : '最初の同期をしましょう';
  const detail = state === 'same' ? 'この端末とクラウドは同じ内容です。' : conflict ? '両方に変更があります。自動では上書きしません。' : state === 'cloud' ? '確認してから、この端末に取り込みます。' : 'この端末の問題・メモ・学習履歴をクラウドに保存します。';
  const counts = <div className="sync-overview-counts">
    <div><span>この端末</span><strong>{local.questionCount}問</strong><small>{local.problemSetCount}セット</small></div>
    <span aria-hidden="true">⇄</span>
    <div><span>クラウド</span><strong>{remote ? `${remote.questionCount}問` : '未保存'}</strong><small>{remote ? `${remote.problemSetCount}セット` : '初回保存前'}</small></div>
  </div>;
  const choices = <div className="sync-overview-choices">
    <button type="button" className="sync-button sync-button--primary" disabled={disabled} onClick={onUpload}>この端末の内容を使う<small>クラウドへ保存</small></button>
    {remote ? <button type="button" className="sync-button sync-button--secondary" disabled={disabled} onClick={onDownload}>クラウドの内容を使う<small>この端末へ取り込む</small></button> : null}
    <p className="sync-help">置き換え前に確認します。別々の内容を結合する操作ではありません。</p>
  </div>;
  return <>
    <div className={`sync-overview-status${conflict ? ' sync-overview-status--conflict' : ''}`}>
      <span className="sync-overview-symbol" aria-hidden="true">{state === 'same' ? '✓' : conflict ? '!' : '⇄'}</span>
      <h2>{title}</h2><p>{detail}</p>
    </div>
    {conflict ? <>{counts}{choices}</> : <>
      <button type="button" className="sync-button sync-button--primary sync-overview-main" disabled={disabled} onClick={onSync}>{disabled ? '処理中…' : state === 'same' ? '更新を確認' : '今すぐ同期'}</button>
      <details className="sync-overview-details"><summary>内容を確認{state !== 'same' ? '・手動で選ぶ' : ''}</summary>{counts}{state !== 'same' ? choices : null}</details>
    </>}
  </>;
}
