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

export function SyncStatus({ syncId, accountId, recordEnabled, autoEnabled, lastState, disabled, onLogin, detailsOpen = false, diagnosticsOnly = false, onInitialSync,choiceOpen=false,onChooseSource }: {
  syncId: string; accountId: string; recordEnabled: boolean; autoEnabled: boolean; lastState: LastSyncState; disabled: boolean; onLogin: () => void; detailsOpen?: boolean; diagnosticsOnly?: boolean; onInitialSync?: () => void;choiceOpen?:boolean;onChooseSource?:()=>void;
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
  const complete = presentation.text === '同期済み' && attempt?.phase === 'done';
  const showProgress = attempt?.phase === 'running' || attempt?.phase === 'queued' && !attempt.retryAt || attempt?.overallPercent !== undefined;
  const progress = attempt?.progress;
  const percentage = complete ? 100 : Math.min(99,Math.max(0,attempt?.overallPercent??0));
  const activeFailure=attempt?.lastFailure&&(attempt.phase==='failed'||attempt.phase==='paused'&&attempt.pauseReason===attempt.lastFailure.code)?attempt.lastFailure:null;
  const canChoose=Boolean(onChooseSource&&record?.conflicts&&activeFailure&&['invalid_response','invalid','media_pending','media_unsupported'].includes(activeFailure.code));
  if(choiceOpen&&!detailsOpen&&!diagnosticsOnly)return null;
  return <section className="sync-status-card" aria-live="polite">
    {!diagnosticsOnly && presentation.text === '同期済み' ? <svg className="sync-complete-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><path d="m19 32 9 9 18-19"/></svg> : null}
    {!diagnosticsOnly ? <h2>{onInitialSync ? '初回のデータを確認してください' : activeFailure?'同期できませんでした':summary}</h2> : null}
    {!diagnosticsOnly && reason ? <p className="sync-status-reason">{reason}</p> : null}
    {!diagnosticsOnly && showProgress ? <div className="sync-progress" aria-live="polite">
      <div className="sync-progress__label"><span>{complete?'同期完了':'全体の進捗（目安）'}</span><strong>{percentage}%</strong></div>
      <div className="sync-progress__track" role="progressbar" aria-label="同期全体の進捗（目安）" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={`${percentage}%${complete?' 同期完了':''}`}><span className="sync-progress__fill" style={{width:`${percentage}%`}}/></div>
      {!complete ? <small>{progress?.label ?? syncStageLabel(attempt?.step ?? '')}{progress && progress.completed > 0 ? ` · ${progress.total ? `${progress.completed.toLocaleString('ja-JP')} / ${progress.total.toLocaleString('ja-JP')} 件` : `${progress.completed.toLocaleString('ja-JP')} 件完了`}` : ''}</small> : null}
    </div> : null}
    {!diagnosticsOnly && complete && attempt?.notice ? <p className="sync-status-reason">{attempt.notice}</p> : null}
    {!diagnosticsOnly && attempt?.phase === 'queued' && attempt.retryAt && attempt.retryAt > Date.now() ? <p>{new Date(attempt.retryAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}に再試行します。</p> : null}
    {!diagnosticsOnly ? <p>最終成功 {success ? new Date(success).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '未実行'}</p> : null}
    {diagnosticsOnly ? null : onInitialSync ? <button type="button" className="sync-button sync-button--primary" disabled={disabled || !online} onClick={onInitialSync}>初回のデータを確認</button> : canChoose ? <button type="button" className="sync-button sync-button--primary" disabled={disabled} onClick={onChooseSource}>使うデータを選び直す</button> : presentation.action === 'login' ? <button type="button" className="sync-button sync-button--primary" onClick={onLogin}>ログイン</button> : presentation.action === 'retry' ? <button type="button" className="sync-button sync-button--primary"
      disabled={disabled || !online} onClick={() => requestSyncRetry(syncId)}>再試行</button> : null}
    {detailsOpen && lastState.error ? <p role="alert">{lastState.error}</p> : null}
    {detailsOpen && readError ? <p role="alert">{readError}</p> : null}
    {detailsOpen && attempt?.lastFailure ? <>
      <p>前回の失敗：{attempt.lastFailure.step} / {attempt.lastFailure.code} / {new Date(attempt.lastFailure.at).toLocaleString('ja-JP')}</p>
      <p role="alert">{safeSyncFailureMessage(attempt.lastFailure.message)}</p>
    </> : null}
  </section>;
}
