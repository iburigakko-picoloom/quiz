import { useEffect, useRef, useState } from 'react';
import { SyncDataChoice } from './SyncDataChoice';
import { getSavedBackup, listSavedBackups, saveBackupPayload, type SavedBackupSummary } from '../utils/backupRepository';
import { exportQuizMakeRecoveryData, validateSyncPayload } from '../utils/syncService';
import { formatSyncTime } from '../utils/syncPresentation';

const backupKinds = {
  manual: '手動で保存',
  'before-import': '復元前に保存',
  'before-sync': '同期前に保存',
  'before-logout': 'ログアウト前に保存',
};

export function SyncBackupPanel({ onRestore, onBusyChange }: {
  onRestore?: (file: File) => Promise<string | null>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<SavedBackupSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void listSavedBackups().then((backups) => {
      if (active) setItems(backups);
    }).catch(() => {
      if (active) setError('バックアップを読み込めませんでした。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setMessage('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '処理を完了できませんでした。'); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  };
  const restore = () => run(async () => {
    if (!selectedId || !onRestore) return;
    const saved = await getSavedBackup(selectedId);
    if (!saved) throw new Error('バックアップが見つかりません。選び直してください。');
    const validation = validateSyncPayload(JSON.parse(saved.raw));
    if (!validation.ok) throw new Error(validation.error);
    // The app opens its existing confirmation screen and protects the restore operation.
    const result = await onRestore(new File([saved.raw], `quiz-make-backup-${saved.createdAt.replace(/[:.]/g, '-')}.json`, { type: 'application/json' }));
    if (result) throw new Error(result);
  });

  return <section className="sync-backup-panel" aria-busy={loading || busy}>
    <h2 className="sync-page-heading">バックアップを選ぶ</h2>
    {loading ? <p className="sync-help" role="status">バックアップを読み込み中…</p> : null}
    {error ? <div className="sync-overview-error" role="alert"><p>{error}</p><button type="button" className="sync-button sync-button--secondary" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>もう一度確認</button></div> : null}
    {!loading && !error && !items.length ? <p className="sync-backup-empty">保存されたバックアップはありません。<br />現在のデータを保存しておくと、ここから復元できます。</p> : null}
    <fieldset className="sync-data-choices" disabled={loading || busy}>
      <legend className="sync-visually-hidden">復元するバックアップ</legend>
      {items.map((item) => <SyncDataChoice key={item.id} name="sync-backup" value={item.id}
        title={item.sourceLabel || '保存済みデータ'} timestamp={formatSyncTime(item.createdAt, false)} questionCount={item.questionCount}
        note={backupKinds[item.kind]} checked={selectedId === item.id} onChange={() => setSelectedId(item.id)} />)}
    </fieldset>
    <button type="button" className="sync-button sync-button--primary sync-selection-submit" disabled={loading || busy || !onRestore || !items.some((item) => item.id === selectedId)} onClick={() => void restore()}>{busy ? '処理中…' : '復元する'}</button>
    <p className="sync-selection-note">{selectedId ? '復元前に確認画面を表示します' : 'バックアップを選択してください'}</p>
    {message ? <p className="sync-help" role="status">{message}</p> : null}
    <button type="button" className="sync-backup-save" disabled={loading || busy} onClick={() => void run(async () => {
      await saveBackupPayload(await exportQuizMakeRecoveryData(), 'manual');
      setMessage('現在のデータをバックアップに保存しました。');
      setAttempt((value) => value + 1);
    })}>現在のデータをバックアップに保存</button>
  </section>;
}
