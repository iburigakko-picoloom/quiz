import { useEffect, useState } from 'react';
import { openAppDb } from '../storage';
import { getRemoteSyncConfig, isLocalSyncUnchanged, type LastSyncState } from '../utils/syncService';
import { readRecordSyncStatus, RECORD_SYNC_STATE_EVENT, type RecordSyncStatus } from '../utils/recordSyncStatus';
import { syncStatusPresentation } from '../utils/syncStatusPresentation';
import { readSyncAttemptStatus, SYNC_ATTEMPT_EVENT, type SyncAttemptStatus } from '../utils/syncAttemptStatus';
import { LOCAL_DATA_SAVED_EVENT } from '../utils/localDataRevision';
import { requestSyncRetry } from '../utils/syncRequest';

export function SyncStatus({ syncId, accountId, recordEnabled, autoEnabled, lastState, disabled, onLogin, detailsOpen = false }: {
  syncId: string; accountId: string; recordEnabled: boolean; autoEnabled: boolean; lastState: LastSyncState; disabled: boolean; onLogin: () => void; detailsOpen?: boolean;
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
  const loginRequired = lastState.status.includes('ログイン');
  const success = recordEnabled ? record?.lastSuccessAt : lastState.lastSyncAt;
  const presentation = syncStatusPresentation({ online, loginRequired, error: failed, readError: Boolean(readError), attempt, autoEnabled, recordEnabled, record, pending, success: success ?? '' });
  const summary = presentation.text === '変更の確認があります' && record?.conflicts ? `変更の確認が${record.conflicts}件あります` : presentation.text;
  return <section className="sync-status-card" aria-live="polite">
    <h2>{summary}</h2>
    {presentation.action ? <p>変更は端末に保持しています。</p> : null}
    {attempt?.phase === 'queued' && attempt.retryAt ? <p>{new Date(attempt.retryAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}に再試行します。</p> : null}
    {detailsOpen ? <p>最終成功 {success ? new Date(success).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '未実行'}</p> : null}
    {presentation.action === 'login' ? <button type="button" className="sync-button sync-button--primary" onClick={onLogin}>ログイン</button> : presentation.action === 'retry' ? <button type="button" className="sync-button sync-button--primary"
      disabled={disabled || !online} onClick={() => requestSyncRetry(syncId)}>再試行</button> : null}
    {detailsOpen && readError ? <p role="alert">{readError}</p> : null}
    {detailsOpen && attempt?.lastFailure ? <p>前回の失敗：{attempt.lastFailure.step} / {attempt.lastFailure.code} / {new Date(attempt.lastFailure.at).toLocaleString('ja-JP')}</p> : null}
  </section>;
}
