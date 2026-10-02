import { useEffect, useState } from 'react';
import { openAppDb } from '../storage';
import { getRemoteSyncConfig, isLocalSyncUnchanged, type LastSyncState } from '../utils/syncService';
import { readRecordSyncStatus, recordSyncSummary, RECORD_SYNC_STATE_EVENT, type RecordSyncStatus } from '../utils/recordSyncStatus';
import { LOCAL_DATA_SAVED_EVENT } from '../utils/localDataRevision';
import { requestSyncRetry } from '../utils/syncRequest';

export function SyncStatus({ syncId, accountId, recordEnabled, autoEnabled, lastState, disabled, onLogin }: {
  syncId: string; accountId: string; recordEnabled: boolean; autoEnabled: boolean; lastState: LastSyncState; disabled: boolean; onLogin: () => void;
}) {
  const [record, setRecord] = useState<RecordSyncStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState('');
  const [online, setOnline] = useState(navigator.onLine !== false);
  useEffect(() => {
    let stopped = false;
    let reading = false;
    setRecord(null); setReadError(''); setPending(false);
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const config = getRemoteSyncConfig();
        if (!config) throw new Error('接続設定を確認できません。');
        const state = recordEnabled ? await readRecordSyncStatus(await openAppDb(), { project: new URL(config.url).origin, userId: accountId, syncId }) : null;
        const localPending = recordEnabled ? false : !(await isLocalSyncUnchanged(lastState.lastSyncDigest));
        if (!stopped) { setRecord(state); setPending(localPending); setReadError(''); }
      } catch (error) { if (!stopped) setReadError(error instanceof Error ? error.message : '同期状態を確認できません。'); }
      finally { reading = false; }
    };
    const update = () => { setOnline(navigator.onLine !== false); void refresh(); };
    void refresh();
    const timer = window.setInterval(update, 5000);
    for (const event of [RECORD_SYNC_STATE_EVENT, LOCAL_DATA_SAVED_EVENT, 'storage', 'online', 'offline']) window.addEventListener(event, update);
    return () => { stopped = true; window.clearInterval(timer); for (const event of [RECORD_SYNC_STATE_EVENT, LOCAL_DATA_SAVED_EVENT, 'storage', 'online', 'offline']) window.removeEventListener(event, update); };
  }, [syncId, accountId, recordEnabled, lastState.lastSyncDigest]);
  const failed = Boolean(readError || lastState.error);
  const loginRequired = lastState.status.includes('ログイン');
  const summary = !online ? 'オフライン・変更は端末に保存しています'
    : loginRequired ? 'ログインが必要です。未送信の変更は保持しています'
    : failed ? '同期を完了できません。未送信の変更は保持しています'
    : recordEnabled ? record ? recordSyncSummary(record) : '同期状態を確認中…'
    : pending ? '未送信の変更があります' : lastState.lastSyncAt ? '同期済み' : '最初の同期を確認してください';
  const success = recordEnabled ? record?.lastSuccessAt : lastState.lastSyncAt;
  return <section className="sync-status-card" aria-live="polite">
    <h2>{summary}</h2>
    <p>最終成功 {success ? new Date(success).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '未実行'}</p>
    {!autoEnabled ? <p>自動同期はOFFです</p> : null}
    {loginRequired ? <button type="button" className="sync-button sync-button--primary" onClick={onLogin}>ログイン</button> : failed || pending || !autoEnabled || !success || record?.pending ? <button type="button" className="sync-button sync-button--primary"
      disabled={disabled || !online} onClick={() => requestSyncRetry(syncId)}>再試行</button> : null}
    {readError ? <details><summary>状態確認の詳細</summary><p role="alert">{readError}</p></details> : null}
  </section>;
}
