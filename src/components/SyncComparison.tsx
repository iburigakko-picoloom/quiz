import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { computePayloadDigest, downloadSyncData, exportQuizMakeData, getLastSyncState, getStoredSyncId, summarizeSyncPayload, type SyncPayload, type SyncPayloadSummary } from '../utils/syncService';
import { saveBackupPayload } from '../utils/backupRepository';
import { readSyncOverview, readSyncPreview, type SyncOverview } from '../utils/syncPreview';
import { CheckIcon, SyncIcon } from './UiIcons';
import { SyncDataChoice } from './SyncDataChoice';
import { formatSyncTime, getSyncDeviceName, getSyncLocalSavedAt } from '../utils/syncPresentation';

type Comparison = SyncOverview;
export function SyncComparison({ syncId, disabled, autoEnabled = true, onStateChange, onUpload, onDownload }: { syncId: string; disabled: boolean; autoEnabled?: boolean; onStateChange?: (state: SyncViewState) => void; onUpload: (payload?: SyncPayload, confirmedRemoteUpdatedAt?: string) => Promise<void>; onDownload: () => Promise<void> }) {
  const [value,setValue] = useState<Comparison | null>(null);
  const [pending,setPending] = useState<Comparison | null>(null);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const [detailsLoading,setDetailsLoading] = useState(false);
  const [detailsError,setDetailsError] = useState('');
  const [attempt,setAttempt] = useState(0);
  const lock = useRef(false);
  const requestId = useRef(0);
  useEffect(() => {
    let active = true;
    const currentRequest = ++requestId.current;
    if (disabled) { if (!lock.current) setLoading(false); return; }
    setLoading(true); setError(''); setDetailsError(''); setDetailsLoading(false);
    setValue((current) => current?.syncId === syncId ? current : null);
    void readSyncOverview(syncId).then((overview) => {
      if (active && requestId.current === currentRequest) setValue(overview);
    }).catch((reason) => { if(active) setError(reason instanceof Error ? reason.message : '同期状態を確認できません。'); }).finally(() => {if(active) setLoading(false);});
    return () => { active = false; };
  },[syncId,disabled,attempt]);
  const loadDetails = async () => {
    if (!value || value.detailed || detailsLoading || disabled) return;
    const currentRequest = requestId.current;
    setDetailsLoading(true); setDetailsError('');
    try {
      const detailed = await readSyncPreview(value.syncId);
      if (requestId.current !== currentRequest) return;
      if (await computePayloadDigest(detailed.local) !== await computePayloadDigest(value.local)
        || detailed.remote?.updatedAt !== value.remote?.updatedAt) {
        setAttempt((n) => n + 1);
        return;
      }
      setValue({ ...value, local: detailed.local,
        remote: detailed.remote, state: detailed.same ? 'same' : value.state, detailed });
    } catch (reason) {
      if (requestId.current === currentRequest) setDetailsError(reason instanceof Error ? reason.message : '内容を確認できませんでした。');
    } finally {
      if (requestId.current === currentRequest) setDetailsLoading(false);
    }
  };
  const confirm = async () => {
    if (!pending || lock.current) return;
    lock.current = true; setLoading(true); setError('');
    try {
      if (!navigator.onLine || getStoredSyncId().trim() !== pending.syncId) throw new Error('接続状態が変わりました。同期状態を確認し直してください。');
      const [local,remote] = await Promise.all([exportQuizMakeData(), downloadSyncData(pending.syncId)]);
      if (!remote.ok) throw new Error(remote.error);
      if (await computePayloadDigest(local) !== await computePayloadDigest(pending.local) || remote.value?.updatedAt !== pending.remote?.updatedAt) throw new Error('確認中にデータが更新されました。同期状態を確認し直してください。');
      await saveBackupPayload(local,'before-sync');
      if (remote.value) await saveBackupPayload(remote.value.payload,'before-sync', 'クラウド');
      await onUpload(local, remote.value?.updatedAt); setPending(null); setAttempt((n) => n+1);
    } catch(reason) { setError(reason instanceof Error ? reason.message : '同期を完了できませんでした。'); setPending(null); }
    finally {lock.current = false; setLoading(false);}
  };
  const syncNormally = async () => {
    if (!value || lock.current || disabled) return;
    lock.current = true; setLoading(true); setError('');
    try {
      if (value.state === 'conflict') {
        setError('両方に変更があります。残す内容を選んでください。');
        return;
      }
      if (value.state === 'same') { setAttempt((n) => n + 1); return; }
      if (value.state === 'cloud') await onDownload();
      else await onUpload();
      setAttempt((n) => n + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '同期できませんでした。'); }
    finally { lock.current = false; setLoading(false); }
  };
  const local = useMemo(() => value && summarizeSyncPayload(value.local), [value]);
  const remote = useMemo(() => value?.detailed?.remote && summarizeSyncPayload(value.detailed.remote.payload), [value]);
  const last = getLastSyncState();
  useEffect(() => { if (value) onStateChange?.(value.state); }, [value, onStateChange]);
  useEffect(() => {
    if (value?.state === 'conflict' && !value.detailed && !disabled) void loadDetails();
  }, [value, disabled]);
  return <section className="qm-sync-comparison" aria-label="同期の状態" aria-busy={loading || disabled}>
    {!value && (loading || !error) ? <div className="sync-overview-loading" role="status">
      <strong>{disabled ? '同期処理中…' : 'クラウドの更新を確認中…'}</strong>
      {!disabled && last.lastSyncAt ? <small>前回の同期：{new Date(last.lastSyncAt).toLocaleString()}</small> : null}
    </div> : null}
    {error ? <div className="sync-overview-error" role="alert"><p>{error}</p><button className="sync-button sync-button--secondary" disabled={loading || disabled} onClick={() => setAttempt((n) => n+1)}>もう一度確認</button></div> : null}
    {!value && error ? <div className="sync-overview-choices">
      <p className="sync-help">新しい端末では、保存済みのクラウドデータを確認して取り込めます。クラウドは上書きしません。</p>
      <button type="button" className="sync-button sync-button--primary" disabled={loading || disabled} onClick={() => void onDownload()}>クラウドの保存データを確認・取り込む</button>
    </div> : null}
    {value && local ? <SyncComparisonView key={`${value.syncId}:${value.remote?.updatedAt ?? ''}:${value.state}`} state={value.state} local={local} remote={remote || null} remoteExists={Boolean(value.remote)} disabled={disabled || loading || Boolean(error)} autoEnabled={autoEnabled}
      localUpdatedAt={getSyncLocalSavedAt()} remoteUpdatedAt={value.remote?.updatedAt}
      detailsLoading={detailsLoading} detailsError={detailsError} onOpenDetails={() => void loadDetails()}
      onSync={() => void syncNormally()} onUpload={() => setPending(value)} onDownload={() => void onDownload()} /> : null}
    <ConfirmDialog fullPage open={Boolean(pending)} title="端末の内容でクラウドを置き換えますか？" message={pending ? `残す内容：端末の${local?.questionCount ?? 0}問\n上書きする側：クラウド${pending.remote ? `（${new Date(pending.remote.updatedAt).toLocaleString()}）` : '（未登録）'}\n\n両方の復元用バックアップを作成・読み戻し確認してから実行します。` : ''} confirmLabel={loading ? '処理中…' : 'バックアップしてクラウドを置き換える'} busy={loading} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />
  </section>;
}

export type SyncViewState = 'same' | 'local' | 'cloud' | 'conflict';
/** Presentation only: this component cannot access or modify stored learning data. */
export function SyncComparisonView({ state, local, remote, remoteExists = Boolean(remote), disabled, autoEnabled = true, localUpdatedAt = '', remoteUpdatedAt = '', detailsLoading = false, detailsError = '', onOpenDetails, onSync, onUpload, onDownload }: {
  state: SyncViewState; local: SyncPayloadSummary; remote: SyncPayloadSummary | null; remoteExists?: boolean; disabled: boolean;
  autoEnabled?: boolean; localUpdatedAt?: string; remoteUpdatedAt?: string;
  detailsLoading?: boolean; detailsError?: string; onOpenDetails?: () => void;
  onSync: () => void; onUpload: () => void; onDownload: () => void;
}) {
  const [selected, setSelected] = useState<'local' | 'cloud'>('local');
  const conflict = state === 'conflict';
  const unresolvedConflict = conflict && remoteExists && !remote;
  const title = state === 'same' ? '同期済み' : state === 'cloud' ? 'クラウドに更新があります' : remoteExists ? 'この端末に変更があります' : '最初の同期をしましょう';
  const detail = state === 'same' ? autoEnabled ? '同じアカウントで自動同期' : '自動同期はオフです' : state === 'cloud' ? '最新のデータをこの端末に取り込みます' : '問題・メモ・学習履歴をクラウドに保存します';
  const counts = <div className="sync-overview-counts">
    <div><span>この端末</span><strong>{local.questionCount}問</strong><small>{local.problemSetCount}セット</small></div>
    <span aria-hidden="true">⇄</span>
    <div><span>クラウド</span><strong>{remote ? `${remote.questionCount}問` : remoteExists ? '保存済み' : '未保存'}</strong><small>{remote ? `${remote.problemSetCount}セット` : remoteExists ? '内容は確認時に取得' : '初回保存前'}</small></div>
  </div>;
  const choices = <>
    <fieldset className="sync-data-choices" disabled={disabled || detailsLoading || unresolvedConflict}>
      <legend className="sync-visually-hidden">使うデータ</legend>
      <SyncDataChoice name="sync-source" value="local" title={getSyncDeviceName()} timestamp={localUpdatedAt ? formatSyncTime(localUpdatedAt) : '保存日時不明'} questionCount={local.questionCount} checked={selected === 'local'} onChange={() => setSelected('local')} />
      {remoteExists ? <SyncDataChoice name="sync-source" value="cloud" title="クラウド" timestamp={formatSyncTime(remoteUpdatedAt)} questionCount={remote?.questionCount} checked={selected === 'cloud'} onChange={() => setSelected('cloud')} /> : null}
    </fieldset>
    {detailsLoading ? <p className="sync-help" role="status">クラウドの件数を確認中…</p> : null}
    {detailsError ? <div className="sync-overview-error" role="alert"><p>{detailsError}</p><button type="button" className="sync-button sync-button--secondary" disabled={disabled || detailsLoading} onClick={onOpenDetails}>もう一度確認</button></div> : null}
    <button type="button" className="sync-button sync-button--primary sync-selection-submit" disabled={disabled || detailsLoading || unresolvedConflict} onClick={selected === 'local' ? onUpload : onDownload}>このデータを使う</button>
    <p className="sync-selection-note">選ばなかったデータは<br />復旧用に保存</p>
  </>;
  return <>
    {conflict ? <>
      <h2 className="sync-page-heading">使うデータを選択</h2>
      <p className="sync-page-description">両方の端末で変更があります</p>
      {choices}
    </> : <>
      <div className="sync-overview-status">
        <span className="sync-overview-symbol" aria-hidden="true">{state === 'same' ? <CheckIcon size={38} /> : <SyncIcon size={34} />}</span>
        <h2>{title}</h2><p>{detail}</p>
      </div>
      {state !== 'same' ? <>
        <button type="button" className="sync-button sync-button--primary sync-overview-main" disabled={disabled} onClick={onSync}>{disabled ? '処理中…' : '今すぐ同期'}</button>
        <details className="sync-overview-details" onToggle={(event) => { if (event.currentTarget.open) onOpenDetails?.(); }}><summary>使うデータを選ぶ</summary>{counts}{choices}</details>
      </> : null}
    </>}
  </>;
}
