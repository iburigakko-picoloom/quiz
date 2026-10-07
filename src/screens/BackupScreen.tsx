import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ActionMenu } from '../components/ActionMenu';
import { SyncDataChoice } from '../components/SyncDataChoice';
import { validateSyncPayload } from '../utils/syncService';
import { deleteSavedBackup, getSavedBackup, listSavedBackups, saveBackupPayload, type SavedBackupSummary } from '../utils/backupRepository';
import { saveJsonBackup } from '../utils/nativePlatform';
import { RecordConflictRecovery } from '../components/RecordConflictRecovery';
import { exportFileBackup, validateFileBackup } from '../utils/backupPayload';
import { deleteWholeRecovery, getWholeRecovery, listWholeRecovery } from '../utils/wholeRecovery';
import './BackupScreen.css';

const kinds = { manual:'手動', 'before-import':'読み込み前に自動作成', 'before-sync':'同期前に自動作成', 'before-logout':'ログアウト前に自動作成', 'before-restore':'全体復元前・画像とPDFを含む', conflict:'全体の選択前・画像とPDFを含む' };
type BackupRow=Omit<SavedBackupSummary,'kind'> & {kind:keyof typeof kinds};
export function BackupScreen({ onBack, onRestore, onOpenSyncRecovery, onExitGuardChange }: { onBack: () => void; onRestore: (file: File) => Promise<string | null>; onOpenSyncRecovery?: () => void; onExitGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items,setItems] = useState<BackupRow[]>([]);
  const [selectedId,setSelectedId] = useState('');
  const [selectedCount,setSelectedCount] = useState<number>();
  const [busy,setBusy] = useState(false);
  const [recoveryBusy,setRecoveryBusy] = useState(false);
  const [error,setError] = useState('');
  const [deleting,setDeleting] = useState<BackupRow | null>(null);
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
  const refresh = () => Promise.all([listSavedBackups(),listWholeRecovery()]).then(([saved,whole])=>setItems([...saved,...whole].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)))).catch(() => setError('バックアップを読み込めませんでした。'));
  const readBackup=async(id:string)=>id.startsWith('quizMake:wholeRecovery:')?await getWholeRecovery(id):(await getSavedBackup(id))?.raw;
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let stopped=false; setSelectedCount(undefined);
    if(selectedId)void readBackup(selectedId).then(raw=>{if(!raw||stopped)return;try{const value=JSON.parse(raw);const questions=JSON.parse(value.localStorage?.['quiz-make-app-data-v1']??'null')?.questions;if(Array.isArray(questions))setSelectedCount(questions.length);}catch{/* Restoration validates the original before any replacement. */}}).catch(()=>undefined);
    return()=>{stopped=true;};
  }, [selectedId]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : '処理を完了できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Layout><main className="library-page backup-page">
    <header className="library-page__header"><BackButton onClick={onBack} disabled={busy || recoveryBusy} /><h1>バックアップ・復旧</h1></header>
    <section aria-label="ファイル保存と復元"><h2>ファイルで保管</h2><p>端末の故障・紛失に備え、別の場所へファイルを保管してください。</p>
      <button className="qm-primary" disabled={busy || recoveryBusy} onClick={() => void run(async () => { const payload=await exportFileBackup({recovery:true}); const raw = JSON.stringify(payload); await saveJsonBackup(`quiz-make-${new Date().toISOString().replace(/[:.]/g,'-')}.json`, raw);if(payload.backupManifest.completeness==='partial')setError('部分的な救出ファイルです。完全復元用ではありません。'+payload.backupManifest.issues.join(' ')); })}>ファイルに保存</button>
      <button className="qm-secondary" disabled={busy || recoveryBusy} onClick={() => fileInput.current?.click()}>ファイルから復元</button>
      <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { const issue = await onRestore(file); if (issue) throw new Error(issue); }); }} />
    </section>
    <h2>バックアップを選ぶ</h2><p>この端末に保存したコピーから復元します。復元前に確認画面を表示します。</p>
    {error ? <p className="qm-wrong" role="alert">{error}<button onClick={() => void refresh()}>再試行</button></p> : null}
    {!items.length && !error ? <p>{busy ? '処理中…' : '端末内コピーはありません'}</p> : null}
    <fieldset className="sync-data-choices" disabled={busy || recoveryBusy}><legend className="sync-choice-hidden">復元するバックアップ</legend>
      {items.map((item) => <div key={item.id} className="backup-choice-row">
        <SyncDataChoice name="backup-to-restore" value={item.id} title={item.kind==='conflict' ? '選ばなかったデータ' : 'この端末のコピー'} timestamp={new Date(item.createdAt).toLocaleString('ja-JP',{dateStyle:'short',timeStyle:'short'})} questionCount={selectedId===item.id ? selectedCount : undefined} note={kinds[item.kind]+'・'+Math.max(1,Math.ceil(item.byteSize/1024))+' KB'} checked={selectedId===item.id} onChange={()=>setSelectedId(item.id)} />
        <ActionMenu className="library-actions"><summary aria-label={new Date(item.createdAt).toLocaleString()+'の操作'}>…</summary><div className="library-actions__body">
          <button disabled={busy || recoveryBusy} onClick={() => void run(async () => { const raw = await readBackup(item.id); if (!raw) throw new Error('バックアップが見つかりません。'); const value=JSON.parse(raw);const parsed = value?.backupManifest ? await validateFileBackup(value) : validateSyncPayload(value); if (!parsed.ok) throw new Error('バックアップを検証できません。'); await saveJsonBackup('quiz-make-backup-'+item.createdAt.replace(/[:.]/g,'-')+'.json', raw); })}>書き出し</button>
          <button disabled={busy || recoveryBusy} onClick={() => setDeleting(item)}>削除</button>
        </div></ActionMenu>
      </div>)}
    </fieldset>
    <button className="qm-primary backup-restore-button" disabled={busy || recoveryBusy || !items.some(item=>item.id===selectedId)} onClick={()=>void run(async()=>{const item=items.find(value=>value.id===selectedId);if(!item)throw new Error('バックアップを選択してください。');const raw=await readBackup(item.id);if(!raw)throw new Error('バックアップが見つかりません。');const result=await onRestore(new File([raw],'quiz-make-backup-'+item.createdAt.replace(/[:.]/g,'-')+'.json',{type:'application/json'}));if(result)throw new Error(result);})}>復元する</button>
    <p className="sync-selection-note">{selectedId ? '復元前に確認画面を表示します' : 'バックアップを選択してください'}</p>
    <button className="qm-secondary" disabled={busy || recoveryBusy} onClick={() => void run(async () => { await saveBackupPayload(await exportFileBackup(),'manual'); })}>{busy ? '処理中…' : '端末内コピーを作成'}</button>
    <ConfirmDialog open={Boolean(deleting)} title="このバックアップを削除しますか？" message={deleting ? `${new Date(deleting.createdAt).toLocaleString()}のバックアップだけを削除します。現在の学習データは残ります。` : ''} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void run(async () => { if(deleting) { if(deleting.id.startsWith('quizMake:wholeRecovery:')) await deleteWholeRecovery(deleting.id); else await deleteSavedBackup(deleting.id); if(selectedId===deleting.id)setSelectedId(''); } setDeleting(null); })} />
    <RecordConflictRecovery onCreated={refresh} onBusyChange={setRecoveryBusy} />
    {onOpenSyncRecovery ? <section aria-label="同期の復旧"><h2>同期の復旧</h2><p>初回の取り込みや接続診断が必要なときに使います。旧IDと同期方式の設定は、旧データ移行が必要な場合だけ表示します。</p><button className="qm-secondary" disabled={busy || recoveryBusy} onClick={onOpenSyncRecovery}>同期の復旧を開く</button></section> : null}
  </main></Layout>;
}
