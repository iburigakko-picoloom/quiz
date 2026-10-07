import { useEffect, useState } from 'react';
import { openAppDb } from '../storage';
import { getRemoteSyncConfig, isLocalSyncUnchanged, type LastSyncState } from '../utils/syncService';
import { readRecordSyncStatus, RECORD_SYNC_STATE_EVENT, type RecordSyncStatus } from '../utils/recordSyncStatus';
import { syncStatusPresentation } from '../utils/syncStatusPresentation';
import { readSyncAttemptStatus, SYNC_ATTEMPT_EVENT, type SyncAttemptStatus } from '../utils/syncAttemptStatus';
import { LOCAL_DATA_SAVED_EVENT } from '../utils/localDataRevision';
import { requestSyncRetry } from '../utils/syncRequest';
import { safeSyncFailureMessage } from '../utils/syncFailureDiagnostic';
import { syncStatusReason, syncStageLabel } from '../utils/syncStatusReason';

export function SyncStatus({ syncId, accountId, recordEnabled, autoEnabled, lastState, disabled, onLogin, detailsOpen = false, diagnosticsOnly = false, onInitialSync }: {
  syncId: string; accountId: string; recordEnabled: boolean; autoEnabled: boolean; lastState: LastSyncState; disabled: boolean; onLogin: () => void; detailsOpen?: boolean; diagnosticsOnly?: boolean; onInitialSync?: () => void;
}) {
  const [record, setRecord] = useState<RecordSyncStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState('');
  const [online, setOnline] = useState(navigator.onLine !== false);
  const [attempt, setAttempt] = useState<SyncAttemptStatus | null>(null);
  useEffect(() => {
    let stopped = false;
    let reading = false;
    setRecord(null); setReadError(''); setPending(false); setAttempt(null);
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const config = getRemoteSyncConfig();
        if (!config) throw new Error('接続設定を確認できません。');
        const connection = { project: new URL(config.url).origin, userId: accountId, syncId };
        if (!stopped) setAttempt(readSyncAttemptStatus(connection));
        const state = recordEnabled ? await readRecordSyncStatus(await openAppDb(), { project: new URL(config.url).origin, userId: accountId, syncId }) : null;
        const localPending = recordEnabled ? false : !(await isLocalSyncUnchanged(lastState.lastSyncDigest));
        if (!stopped) { setRecord(state); setPending(localPending); setReadError(''); }
      } catch (error) { if (!stopped) setReadError(error instanceof Error ? error.message : '同期状態を確認できません。'); }
      finally { reading = false; }
    };
    const update = () => { setOnline(navigator.onLine !== false); void refresh(); };
    void refresh();
    const timer = window.setInterval(update, 5000);
    const attemptUpdate = () => {
      const config = getRemoteSyncConfig();
      if (!stopped && config) setAttempt(readSyncAttemptStatus({ project: new URL(config.url).origin, userId: accountId, syncId }));
      void refresh();
    };
    window.addEventListener(SYNC_ATTEMPT_EVENT, attemptUpdate);
    for (const event of [RECORD_SYNC_STATE_EVENT, LOCAL_DATA_SAVED_EVENT, 'storage', 'online', 'offline']) window.addEventListener(event, update);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener(SYNC_ATTEMPT_EVENT, attemptUpdate); for (const event of [RECORD_SYNC_STATE_EVENT, LOCAL_DATA_SAVED_EVENT, 'storage', 'online', 'offline']) window.removeEventListener(event, update); };
  }, [syncId, accountId, recordEnabled, lastState.lastSyncDigest]);
  const failed = Boolean(readError || lastState.error);
  const loginRequired = lastState.status.includes('ログインが必要');
  const success = recordEnabled ? record?.lastSuccessAt : lastState.lastSyncAt;
  const presentation = syncStatusPresentation({ online, loginRequired, error: failed, readError: Boolean(readError), attempt, autoEnabled, recordEnabled, record, pending, success: success ?? '' });
  const summary = presentation.text === '変更の確認があります' && record?.conflicts ? `変更の確認が${record.conflicts}件あります` : presentation.text;
  const reason = syncStatusReason(attempt, record?.conflicts ?? 0, readError, lastState.error ?? '');
  const showProgress = attempt?.phase === 'running' || attempt?.phase === 'queued' && !attempt.retryAt;
  const progress = attempt?.progress;
  const percentage = progress?.total ? Math.floor(progress.completed / progress.total * 100) : undefined;
  return <section className="sync-status-card" aria-live="polite">
    {!diagnosticsOnly && presentation.text === '同期済み' ? <svg className="sync-complete-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><path d="m19 32 9 9 18-19"/></svg> : null}
    {!diagnosticsOnly ? <h2>{onInitialSync ? '初回のデータを確認してください' : summary}</h2> : null}
    {!diagnosticsOnly && reason ? <p className="sync-status-reason">{reason}</p> : null}
    {!diagnosticsOnly && showProgress ? <div className="sync-progress" aria-live="polite">
      <div className="sync-progress__label"><span>{progress?.label ?? syncStageLabel(attempt?.step ?? '')}</span>{percentage !== undefined ? <strong>{percentage}%</strong> : null}</div>
      {progress?.total ? <progress aria-label={progress.label} value={progress.completed} max={progress.total}/> : <progress aria-label={progress?.label ?? '同期中'}/>}
      {progress && progress.completed > 0 ? <small>{progress.total ? `${progress.completed.toLocaleString('ja-JP')} / ${progress.total.toLocaleString('ja-JP')} 件` : `${progress.completed.toLocaleString('ja-JP')} 件完了`}</small> : null}
    </div> : null}
    {!diagnosticsOnly && attempt?.notice ? <p className="sync-status-reason">{attempt.notice}</p> : null}
    {!diagnosticsOnly && presentation.action ? <p>変更は端末に保持しています。</p> : null}
    {!diagnosticsOnly && presentation.action === 'retry' && attempt?.lastFailure ? <p role="alert">{safeSyncFailureMessage(attempt.lastFailure.message)}</p> : null}
    {!diagnosticsOnly && attempt?.phase === 'queued' && attempt.retryAt && attempt.retryAt > Date.now() ? <p>{new Date(attempt.retryAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}に再試行します。</p> : null}
    {!diagnosticsOnly ? <p>最終成功 {success ? new Date(success).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '未実行'}</p> : null}
    {diagnosticsOnly ? null : onInitialSync ? <button type="button" className="sync-button sync-button--primary" disabled={disabled || !online} onClick={onInitialSync}>初回のデータを確認</button> : presentation.action === 'login' ? <button type="button" className="sync-button sync-button--primary" onClick={onLogin}>ログイン</button> : presentation.action === 'retry' ? <button type="button" className="sync-button sync-button--primary"
      disabled={disabled || !online} onClick={() => requestSyncRetry(syncId)}>再試行</button> : null}
    {detailsOpen && lastState.error ? <p role="alert">{lastState.error}</p> : null}
    {detailsOpen && readError ? <p role="alert">{readError}</p> : null}
    {detailsOpen && attempt?.lastFailure ? <>
      <p>前回の失敗：{attempt.lastFailure.step} / {attempt.lastFailure.code} / {new Date(attempt.lastFailure.at).toLocaleString('ja-JP')}</p>
      <p role="alert">{safeSyncFailureMessage(attempt.lastFailure.message)}</p>
    </> : null}
  </section>;
}
