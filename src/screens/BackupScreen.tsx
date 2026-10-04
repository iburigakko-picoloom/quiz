import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ActionMenu } from '../components/ActionMenu';
import { DownloadIcon } from '../components/UiIcons';
import { exportQuizMakeData, exportQuizMakeRecoveryData, validateSyncPayload } from '../utils/syncService';
import { deleteSavedBackup, getSavedBackup, listSavedBackups, saveBackupPayload, type SavedBackupSummary } from '../utils/backupRepository';
import { saveJsonBackup } from '../utils/nativePlatform';
import { RecordConflictRecovery } from '../components/RecordConflictRecovery';
import './BackupScreen.css';

const kinds = { manual:'手動', 'before-import':'読み込み前に自動作成', 'before-sync':'同期前に自動作成', 'before-logout':'ログアウト前に自動作成' };
export function BackupScreen({ onBack, onRestore, onOpenSyncRecovery, onExitGuardChange }: { onBack: () => void; onRestore: (file: File) => Promise<string | null>; onOpenSyncRecovery?: () => void; onExitGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items,setItems] = useState<SavedBackupSummary[]>([]);
  const [busy,setBusy] = useState(false);
  const [recoveryBusy,setRecoveryBusy] = useState(false);
  const [error,setError] = useState('');
  const [deleting,setDeleting] = useState<SavedBackupSummary | null>(null);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    onExitGuardChange?.(() => {
      if (lock.current || recoveryBusy) return false;
      if (deleting) { setDeleting(null); return false; }
      return true;
    });
    return () => onExitGuardChange?.(null);
  });
  const refresh = () => listSavedBackups().then(setItems).catch(() => setError('バックアップを読み込めませんでした。'));
  useEffect(() => { void refresh(); }, []);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : '処理を完了できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Layout><main className="library-page backup-page">
    <header className="library-page__header"><BackButton onClick={onBack} disabled={busy || recoveryBusy} /><h1>バックアップと復旧</h1></header>
    <section aria-label="ファイル保存と復元"><h2>ファイルで保管</h2><p>端末の故障・紛失に備え、別の場所へファイルを保管してください。</p>
      <button className="qm-primary" disabled={busy} onClick={() => void run(async () => { const raw = JSON.stringify(await exportQuizMakeRecoveryData()); await saveJsonBackup(`quiz-make-${new Date().toISOString().replace(/[:.]/g,'-')}.json`, raw); })}>ファイルに保存</button>
      <button className="qm-secondary" disabled={busy} onClick={() => fileInput.current?.click()}>ファイルから復元</button>
      <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { const issue = await onRestore(file); if (issue) throw new Error(issue); }); }} />
    </section>
    <h2>この端末の復旧コピー</h2><p>同じ端末内に保存します。端末の故障・紛失に備えるには、上のファイル保存も必要です。</p>
    <button className="qm-secondary" disabled={busy} onClick={() => void run(async () => { await saveBackupPayload(await exportQuizMakeData(),'manual'); })}>{busy ? '処理中…' : '端末内コピーを作成'}</button>
    {error ? <p className="qm-wrong" role="alert">{error}<button onClick={() => void refresh()}>再試行</button></p> : null}
    {!items.length && !error ? <p>{busy ? '処理中…' : '端末内コピーはありません'}</p> : null}
    {items.map((item) => {
      const size = `${Math.max(1, Math.ceil(item.byteSize / 1024))} KB`;
      return <div key={item.id} className="library-row-with-actions">
        <div className="library-row"><span className="library-icon"><DownloadIcon size={18} /></span><span className="library-row__body"><strong>{new Date(item.createdAt).toLocaleString()}</strong><span>{kinds[item.kind]}・{size}</span></span></div>
        <ActionMenu className="library-actions"><summary aria-label={`${new Date(item.createdAt).toLocaleString()}の操作`}>…</summary><div className="library-actions__body">
          <button disabled={busy} onClick={() => void run(async () => { const saved = await getSavedBackup(item.id); if (!saved) throw new Error('バックアップが見つかりません。'); const result = await onRestore(new File([saved.raw], `quiz-make-backup-${item.createdAt.replace(/[:.]/g,'-')}.json`, {type:'application/json'})); if (result) throw new Error(result); })}>復元</button>
          <button disabled={busy} onClick={() => void run(async () => { const saved = await getSavedBackup(item.id); if (!saved) throw new Error('バックアップが見つかりません。'); const parsed = validateSyncPayload(JSON.parse(saved.raw)); if (!parsed.ok) throw new Error('バックアップを検証できません。'); await saveJsonBackup(`quiz-make-backup-${item.createdAt.replace(/[:.]/g,'-')}.json`, saved.raw); })}>書き出し</button>
          <button disabled={busy} onClick={() => setDeleting(item)}>削除</button>
        </div></ActionMenu>
      </div>;
    })}
    <ConfirmDialog open={Boolean(deleting)} title="このバックアップを削除しますか？" message={deleting ? `${new Date(deleting.createdAt).toLocaleString()}のバックアップだけを削除します。現在の学習データは残ります。` : ''} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void run(async () => { if(deleting) await deleteSavedBackup(deleting.id); setDeleting(null); })} />
    <RecordConflictRecovery onCreated={refresh} onBusyChange={setRecoveryBusy} />
    {onOpenSyncRecovery ? <section aria-label="同期の復旧"><h2>同期の復旧</h2><p>初回の取り込み、接続ID、同期方式、診断が必要なときに使います。</p><button className="qm-secondary" disabled={busy || recoveryBusy} onClick={onOpenSyncRecovery}>同期の復旧を開く</button></section> : null}
  </main></Layout>;
}
