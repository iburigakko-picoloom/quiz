import { useEffect, useRef, useState } from 'react';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DownloadIcon } from '../components/UiIcons';
import { exportQuizMakeData, validateSyncPayload } from '../utils/syncService';
import { deleteSavedBackup, getSavedBackup, listSavedBackups, saveBackupPayload, type SavedBackup } from '../utils/backupRepository';
import { saveJsonBackup } from '../utils/nativePlatform';

const kinds = { manual:'手動', 'before-import':'読み込み前に自動作成', 'before-sync':'同期前に自動作成', 'before-logout':'ログアウト前に自動作成' };
export function BackupScreen({ onBack, onRestore }: { onBack: () => void; onRestore: (file: File) => Promise<string | null> }) {
  const [items,setItems] = useState<SavedBackup[]>([]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [deleting,setDeleting] = useState<SavedBackup | null>(null);
  const lock = useRef(false);
  const refresh = () => listSavedBackups().then(setItems).catch(() => setError('バックアップを読み込めませんでした。'));
  useEffect(() => { void refresh(); }, []);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : '処理を完了できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Layout><main className="library-page">
    <header className="library-page__header"><BackButton onClick={onBack} disabled={busy} /><h1>バックアップ</h1></header>
    <button className="qm-primary" disabled={busy} onClick={() => void run(async () => { await saveBackupPayload(await exportQuizMakeData(),'manual'); })}>{busy ? '処理中…' : 'バックアップを作成'}</button>
    {error ? <p className="qm-wrong" role="alert">{error}<button onClick={() => void refresh()}>再試行</button></p> : null}
    {!items.length && !error ? <p>{busy ? '作成中…' : 'バックアップはありません'}</p> : null}
    {items.map((item) => {
      const size = `${Math.max(1, Math.ceil(new Blob([item.raw]).size / 1024))} KB`;
      return <div key={item.id} className="library-row-with-actions">
        <div className="library-row"><span className="library-icon"><DownloadIcon size={18} /></span><span className="library-row__body"><strong>{new Date(item.createdAt).toLocaleString()}</strong><span>{kinds[item.kind]}・{size}</span></span></div>
        <details className="library-actions"><summary aria-label={`${new Date(item.createdAt).toLocaleString()}の操作`}>…</summary><div className="library-actions__body">
          <button disabled={busy} onClick={() => void run(async () => { const saved = await getSavedBackup(item.id); if (!saved) throw new Error('バックアップが見つかりません。'); const result = await onRestore(new File([saved.raw], `quiz-make-backup-${item.createdAt.replace(/[:.]/g,'-')}.json`, {type:'application/json'})); if (result) throw new Error(result); })}>復元</button>
          <button disabled={busy} onClick={() => void run(async () => { const parsed = validateSyncPayload(JSON.parse(item.raw)); if (!parsed.ok) throw new Error('バックアップを検証できません。'); await saveJsonBackup(`quiz-make-backup-${item.createdAt.replace(/[:.]/g,'-')}.json`, item.raw); })}>書き出し</button>
          <button disabled={busy} onClick={() => setDeleting(item)}>削除</button>
        </div></details>
      </div>;
    })}
    <ConfirmDialog open={Boolean(deleting)} title="このバックアップを削除しますか？" message={deleting ? `${new Date(deleting.createdAt).toLocaleString()}のバックアップだけを削除します。現在の学習データは残ります。` : ''} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void run(async () => { if(deleting) await deleteSavedBackup(deleting.id); setDeleting(null); })} />
  </main></Layout>;
}
