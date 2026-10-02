import { useEffect, useRef, useState } from 'react';
import { openAppDb } from '../storage';
import { getCloudSession, onCloudAuthStateChange } from '../utils/cloudService';
import { getRemoteSyncConfig, getStoredSyncId, exportQuizMakeData } from '../utils/syncService';
import { readAppRecordSnapshot } from '../utils/appRecordStorage';
import { createConflictRecoveryCopy, readArchivedRecordConflicts, type ArchivedRecordConflict } from '../utils/recordConflictRecovery';
import { recordConflictTitle } from '../utils/recordConflictPresentation';
import { saveBackupPayload } from '../utils/backupRepository';
import { saveJsonBackup } from '../utils/nativePlatform';

export function RecordConflictRecovery({ onCreated }: { onCreated: () => Promise<void> }) {
  const [items, setItems] = useState<Array<ArchivedRecordConflict & { title: string }>>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [account, setAccount] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    const apply = (session: Awaited<ReturnType<typeof getCloudSession>>) => { if (!stopped) setAccount(session?.user && !session.user.is_anonymous ? session.user.id : ''); };
    void getCloudSession().then(apply).catch(() => { if (!stopped) setError('復旧用原本のアカウントを確認できません。'); });
    const stop = onCloudAuthStateChange((_event, session) => apply(session));
    return () => { stopped = true; stop(); };
  }, []);
  const config = getRemoteSyncConfig(), syncId = getStoredSyncId();
  useEffect(() => {
    let stopped = false;
    setItems([]); setMessage(''); setError('');
    if (!config || !account || !syncId) return;
    void (async () => {
      const db = await openAppDb();
      const archives = await readArchivedRecordConflicts(db, { project: new URL(config.url).origin, userId: account, syncId });
      const snapshot = await readAppRecordSnapshot(db);
      if (!stopped) setItems(archives.map(item => ({ ...item, title: recordConflictTitle(item.conflict, snapshot?.records ?? new Map()) })));
    })().catch(reason => { if (!stopped) setError(reason instanceof Error ? reason.message : '原本を読み取れません。'); });
    return () => { stopped = true; };
  }, [account, syncId, config?.url, attempt]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const session = await getCloudSession();
      if (session?.user.id !== account || getStoredSyncId() !== syncId || getRemoteSyncConfig()?.url !== config?.url) throw new Error('接続が変わりました。原本を確認し直してください。');
      await action();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '復旧コピーを作成できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="record-recovery">
    <h2>同期で残した原本</h2>
    {error ? <div role="alert"><p>復旧用の原本を確認できません。原本は保持しています。</p><button onClick={() => setAttempt(n => n + 1)}>再試行</button><details><summary>詳細</summary>{error}</details></div> : null}
    {message ? <p role="status">{message}</p> : null}
    {!items.length && !error ? <p>保存された競合の原本はありません。</p> : null}
    {items.map(item => <details key={item.id}>
      <summary>{item.title} {item.savedAt ? new Date(item.savedAt).toLocaleString('ja-JP') : ''}</summary>
      <p>両原本を保持しています。復旧コピーは別の問題としてバックアップへ追加されます。</p>
      <div className="sync-actions">
        {(['local', 'remote'] as const).map(side => <button key={side} className="sync-button" disabled={busy} onClick={() => void run(async () => {
          const payload = await exportQuizMakeData();
          const raw = payload.localStorage['quiz-make-app-data-v1'];
          if (!raw) throw new Error('現在の問題データを確認できません。');
          const copy = createConflictRecoveryCopy(JSON.parse(raw), item.conflict, side);
          await saveBackupPayload({ ...payload, localStorage: { ...payload.localStorage, 'quiz-make-app-data-v1': JSON.stringify(copy) } }, 'before-sync');
          await onCreated();
          setMessage('復旧コピーを含むバックアップを作成しました。内容を確認して復元できます。');
        })}>{side === 'local' ? '端末版' : 'クラウド版'}の復旧コピーを作成</button>)}
        <button className="sync-button" disabled={busy} onClick={() => void run(async () => { await saveJsonBackup(`quiz-make-conflict-originals-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`, JSON.stringify(item, null, 2)); setMessage('両原本を書き出しました。'); })}>両原本のJSONを書き出す</button>
      </div>
    </details>)}
  </section>;
}
