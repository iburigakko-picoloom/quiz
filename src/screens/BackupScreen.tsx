import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ChevronRightIcon, HistoryIcon } from '../components/UiIcons';
import { validateSyncPayload } from '../utils/syncService';
import { deleteSavedBackup, saveBackupPayload } from '../utils/backupRepository';
import { saveJsonBackup } from '../utils/nativePlatform';
import { RecordConflictRecovery } from '../components/RecordConflictRecovery';
import { exportFileBackup, validateFileBackup } from '../utils/backupPayload';
import { deleteWholeRecovery } from '../utils/wholeRecovery';
import { BACKUP_HISTORY_LIMIT, listBackupHistory, readBackupHistoryFile, type BackupHistoryRow } from '../utils/backupHistory';
import './BackupScreen.css';
import { SYNC_ORIGINALS_FORMAT, validateSyncOriginalsFile } from '../utils/syncOriginalBackup';

const formatDate = (value: string) => new Date(value).toLocaleString('ja-JP', { month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' });
function BackupIcon({kind}:{kind:'file'|'folder'|'database'}) {
  return <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='file' ? <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4"/></> : kind==='folder' ? <path d="M3 6h7l2 2h9v12H3Z"/> : <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>}
  </svg>;
}
export function BackupScreen({ onBack, onRestore, onOpenSyncRecovery, onExitGuardChange }: { onBack: () => void; onRestore: (file: File, createdAt?: string) => Promise<string | null>; onOpenSyncRecovery?: () => void; onExitGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [page,setPage] = useState<'main'|'list'>('main');
  const [items,setItems] = useState<BackupHistoryRow[]>([]);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(false);
  const [recoveryBusy,setRecoveryBusy] = useState(false);
  const [error,setError] = useState('');
  const [message,setMessage] = useState('');
  const [detailsOpen,setDetailsOpen] = useState(false);
  const [deleting,setDeleting] = useState<BackupHistoryRow | null>(null);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = async () => { const rows = await listBackupHistory(); setItems(rows.slice(0,BACKUP_HISTORY_LIMIT)); };
  const back = () => { if(lock.current||recoveryBusy)return; if(deleting){setDeleting(null);return;} if(page==='list'){setPage('main');setDetailsOpen(false);setError('');}else onBack(); };
  useLayoutEffect(() => {
    onExitGuardChange?.(() => { if(lock.current||recoveryBusy)return false; if(deleting){setDeleting(null);return false;} if(page==='list'){setPage('main');setDetailsOpen(false);setError('');return false;} return true; });
    return () => onExitGuardChange?.(null);
  });
  useEffect(() => {
    if(page!=='list')return;
    let stopped=false; setLoading(true);setError('');
    void listBackupHistory().then(rows=>{if(!stopped)setItems(rows.slice(0,BACKUP_HISTORY_LIMIT));}).catch(()=>{if(!stopped)setError('バックアップを読み込めませんでした。');}).finally(()=>{if(!stopped)setLoading(false);});
    return()=>{stopped=true;};
  },[page]);
  const run = async (action: () => Promise<void>) => {
    if(lock.current||recoveryBusy)return;
    lock.current=true;setBusy(true);setError('');setMessage('');
    try { await action(); } catch(reason) { setError(reason instanceof Error ? reason.message : '処理を完了できませんでした。'); }
    finally { lock.current=false;setBusy(false); }
  };
  const row = (label:string,icon:ReactNode,action:()=>void) => <button type="button" className="backup-action" disabled={busy||recoveryBusy} onClick={action}>{icon}<span>{label}</span><ChevronRightIcon size={20}/></button>;
  return <Layout><main className="library-page backup-page" data-backup-page={page}>
    <header className="library-page__header"><BackButton onClick={back} disabled={busy||recoveryBusy}/><h1>{page==='main' ? 'バックアップ' : 'バックアップから復元'}</h1></header>
    {page==='main' ? <>
      <section className="backup-actions" aria-label="ファイル"><h2>ファイル</h2>
        {row('ファイルに保存',<BackupIcon kind="file"/>,()=>void run(async()=>{const payload=await exportFileBackup({recovery:true});await saveJsonBackup(`quiz-make-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify(payload));setMessage('ファイルに保存しました。');if(payload.backupManifest.completeness==='partial')setError('部分的な救出ファイルです。完全復元用ではありません。'+payload.backupManifest.issues.join(' '));}))}
        {row('ファイルから復元',<BackupIcon kind="folder"/>,()=>fileInput.current?.click())}
      </section>
      <section className="backup-actions backup-actions--device" aria-label="この端末"><h2>この端末</h2>
        {row('バックアップを取る',<BackupIcon kind="database"/>,()=>void run(async()=>{const saved=await saveBackupPayload(await exportFileBackup(),'manual');setMessage('バックアップを保存しました。');if(saved.cleanupWarning)setError(saved.cleanupWarning);}))}
        {row('バックアップから復元',<HistoryIcon size={30}/>,()=>{setMessage('');setPage('list');})}
        <p className="backup-retention-note">直近{BACKUP_HISTORY_LIMIT}件を保存</p>
      </section>
    </> : <>
      <p className="backup-list-caption">直近{BACKUP_HISTORY_LIMIT}件</p>
      {loading ? <p role="status">読み込み中…</p> : !items.length&&!error ? <p>バックアップはありません</p> : null}
      <div className="backup-history" aria-label="保存済みのバックアップ">
        {items.map(item=><button type="button" className="backup-history-row" key={item.id} disabled={busy||recoveryBusy||loading} onClick={()=>void run(async()=>{const raw=await readBackupHistoryFile(item.id);if(!raw)throw new Error('バックアップが見つかりません。');const issue=await onRestore(new File([raw],`quiz-make-backup-${item.createdAt.replace(/[:.]/g,'-')}.json`,{type:'application/json'}),item.createdAt);if(issue)throw new Error(issue);})}><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time><small>{'format' in item&&item.format==='originals'?'救出原本':item.kind==='manual'?'手動':'自動'}</small><ChevronRightIcon size={20}/></button>)}
      </div>
      <details className="backup-details" open={detailsOpen} onToggle={event=>setDetailsOpen(event.currentTarget.open)}><summary>詳細・旧データの復旧</summary>
        {detailsOpen ? <>
          {items.map(item=><div className="backup-management-row" key={item.id}><span>{formatDate(item.createdAt)}</span><button type="button" disabled={busy||recoveryBusy} onClick={()=>void run(async()=>{const raw=await readBackupHistoryFile(item.id);if(!raw)throw new Error('バックアップが見つかりません。');const value=JSON.parse(raw);const checked=value?.format===SYNC_ORIGINALS_FORMAT ? {ok:await validateSyncOriginalsFile(value)} : value?.backupManifest ? await validateFileBackup(value) : validateSyncPayload(value);if(!checked.ok)throw new Error('バックアップを検証できません。');await saveJsonBackup(`quiz-make-backup-${item.createdAt.replace(/[:.]/g,'-')}.json`,raw);})}>書き出し</button><button type="button" disabled={busy||recoveryBusy} onClick={()=>setDeleting(item)}>削除</button></div>)}
          <RecordConflictRecovery onCreated={refresh} onBusyChange={setRecoveryBusy}/>
          {onOpenSyncRecovery ? <button type="button" disabled={busy||recoveryBusy} onClick={onOpenSyncRecovery}>同期の復旧を開く</button> : null}
        </> : null}
      </details>
    </>}
    <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void run(async()=>{const issue=await onRestore(file);if(issue)throw new Error(issue);});}}/>
    {message ? <p role="status">{message}</p> : null}{error ? <p className="qm-wrong" role="alert">{error}</p> : null}
    <ConfirmDialog open={Boolean(deleting)} title="このバックアップを削除しますか？" message={deleting?`${formatDate(deleting.createdAt)}のバックアップだけを削除します。現在の学習データは残ります。`:''} busy={busy} onCancel={()=>setDeleting(null)} onConfirm={()=>void run(async()=>{if(deleting){if(deleting.id.startsWith('quizMake:wholeRecovery:'))await deleteWholeRecovery(deleting.id);else await deleteSavedBackup(deleting.id);}setDeleting(null);await refresh();})}/>
  </main></Layout>;
}
