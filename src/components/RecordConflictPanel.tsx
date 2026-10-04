import { useEffect, useRef, useState } from 'react';
import { getCloudAccessToken, getCloudSession } from '../utils/cloudService';
import { withCoordinatedDataMutation, withCoordinatedDataRead } from '../utils/dataCoordination';
import { replayLocalStorageProjections } from '../utils/localStorageRecords';
import { readAppRecordSnapshot } from '../utils/appRecordStorage';
import { applyStagedRecordPull, readActiveRecordConflicts, type RecordConflict, type RecordConflictDecision } from '../utils/recordSyncPull';
import { recordConflictIdentity, recordConflictTitle, retainRecordConflictChoices } from '../utils/recordConflictPresentation';
import { compareRecordConflict, conflictPreview } from '../utils/recordConflictComparison';
import { exportRecordConflictOriginals } from '../utils/recordConflictExport';
import { saveJsonBackup } from '../utils/nativePlatform';
import { getRemoteSyncConfig, getStoredSyncId, waitForLocalPersistence } from '../utils/syncService';
import { openAppDb } from '../storage';
import { requestSyncRetry, withRecordSyncLease } from '../utils/syncRequest';

export function RecordConflictPanel({ syncId, accountId, onImported, open, onOpenChange, onOpenBackups }: {
  syncId: string; accountId: string; onImported?: () => Promise<void>;
  open: boolean; onOpenChange: (value: boolean) => void; onOpenBackups?: () => void;
}) {
  const [conflicts, setConflicts] = useState<RecordConflict[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, 'local' | 'remote'>>({});
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const config = getRemoteSyncConfig();
  const project = config ? new URL(config.url).origin : '';
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const busyRef = useRef(false);
  const identitiesRef = useRef(new Map<string, string>());
  const connection = () => {
    if (!config) throw new Error('同期先が設定されていません。');
    return { project: new URL(config.url).origin, userId: accountId, syncId };
  };
  useEffect(() => {
    let stopped = false;
    let loading = false;
    let inspection: { signature: string; visible: RecordConflict[] } | null = null;
    setChoices({}); setConflicts([]); setIndex(0);
    onOpenChangeRef.current(false);
    identitiesRef.current = new Map();
    const load = async () => {
      if (loading || busyRef.current) return;
      loading = true;
      try {
        const db = await openAppDb();
        let found = await readActiveRecordConflicts(db, connection());
        let snapshot = found.length ? await readAppRecordSnapshot(db) : null;
        const signature = JSON.stringify([snapshot?.state.commitId, found.map(recordConflictIdentity)]);
        if (found.length && inspection?.signature !== signature) {
          const saved = await waitForLocalPersistence();
          if (!saved.ok) throw new Error(saved.error);
          const access = await getCloudAccessToken();
          if (!access.ok || access.userId !== accountId) throw new Error('ログイン状態が変わりました。');
          const result = await withRecordSyncLease(navigator.locks, () => withCoordinatedDataRead(['app', 'notes'], async () => {
            if (stopped || getStoredSyncId() !== syncId || getRemoteSyncConfig()?.url !== config?.url) return null;
            // Recover old false conflicts using the same backend merge as auto
            // sync. Rebase metadata only; visible changes still wait for Home.
            return applyStagedRecordPull(db, connection(), [], { preserveLiveData: true });
          }, { requireCrossContext: true }));
          if (result) {
            const visible = !result.applied && 'conflicts' in result ? result.conflicts : [];
            const active = await readActiveRecordConflicts(db, connection());
            snapshot = await readAppRecordSnapshot(db);
            inspection = { signature: JSON.stringify([snapshot?.state.commitId, active.map(recordConflictIdentity)]), visible };
            found = visible;
            if (!stopped && !visible.length) window.dispatchEvent(new Event('quiz-make-sync-settings-change'));
          }
        } else if (inspection?.signature === signature) found = inspection.visible;
        if (stopped) return;
        const previous = identitiesRef.current;
        identitiesRef.current = new Map(found.map(item => [item.key, recordConflictIdentity(item)]));
        setChoices(current => retainRecordConflictChoices(previous, found, current));
        setConflicts(found);
        setTitles(Object.fromEntries(found.map(item => [item.key, recordConflictTitle(item, snapshot?.records ?? new Map())])));
        setError('');
      } catch (caught) {
        if (!stopped) { setChoices({}); setError(caught instanceof Error ? caught.message : '変更の内容を確認できませんでした。'); }
      } finally { loading = false; }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [syncId, accountId, project, config?.anonKey, attempt]);
  useEffect(() => {
    if (!open) { setChoices({}); setIndex(0); setExportError(''); setExportMessage(''); return; }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onOpenChangeRef.current(false); }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary') ?? [])];
      if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); nodes[nodes.length - 1]?.focus(); }
      else if (!event.shiftKey && (document.activeElement === nodes[nodes.length - 1] || document.activeElement === dialogRef.current)) { event.preventDefault(); nodes[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [open]);
  const resolve = async () => {
    if (busyRef.current || conflicts.some(item => !choices[item.key])) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try {
      if (getStoredSyncId() !== syncId || getRemoteSyncConfig()?.url !== config?.url || getRemoteSyncConfig()?.anonKey !== config?.anonKey) throw new Error('接続設定が変わりました。');
      const access = await getCloudAccessToken();
      if (!access.ok || access.userId !== accountId) throw new Error('ログイン状態が変わりました。');
      const saved = await waitForLocalPersistence();
      if (!saved.ok) throw new Error(saved.error);
      const selected: RecordConflictDecision[] = conflicts.map(item => ({
        key: item.key, operationId: item.operationId!, remoteRevision: item.remote.revision, choice: choices[item.key],
      }));
      const applied = await withRecordSyncLease(navigator.locks, () => withCoordinatedDataMutation(['app', 'notes'], async () => {
        if (getStoredSyncId() !== syncId || getRemoteSyncConfig()?.url !== config?.url || getRemoteSyncConfig()?.anonKey !== config?.anonKey) throw new Error('接続設定が変わりました。');
        const latestAccess = await getCloudAccessToken();
        if (!latestAccess.ok || latestAccess.userId !== accountId) throw new Error('ログイン状態が変わりました。');
        const db = await openAppDb();
        const current = await readActiveRecordConflicts(db, connection());
        if (current.length !== conflicts.length || current.some(item => identitiesRef.current.get(item.key) !== recordConflictIdentity(item))) throw new Error('確認中に内容が更新されました。もう一度確認してください。');
        const result = await applyStagedRecordPull(db, connection(), selected);
        if (result.applied) await replayLocalStorageProjections();
        return result;
      }, { requireCrossContext: true }));
      if (!applied?.applied) throw new Error('競合内容が更新されました。もう一度確認してください。');
      await onImported?.();
      setConflicts([]); setChoices({}); onOpenChange(false);
      window.setTimeout(() => requestSyncRetry(syncId), 0);
    } catch (caught) { setChoices({}); setError(caught instanceof Error ? caught.message : '変更を確定できませんでした。'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const current = conflicts[Math.min(index, Math.max(0, conflicts.length - 1))];
  const candidateIdentity = current ? recordConflictIdentity(current) : '';
  useEffect(() => { setExportError(''); setExportMessage(''); }, [candidateIdentity]);
  const remaining = conflicts.filter(item => !choices[item.key]).length;
  const comparison = current ? compareRecordConflict(current) : null;
  const saveOriginals = async () => {
    if (busyRef.current || !current) return;
    busyRef.current = true; setBusy(true); setExportError(''); setExportMessage('');
    try {
      const raw = await withCoordinatedDataRead(['app', 'notes'], async () => {
        const session = await getCloudSession();
        if (!session?.user || session.user.is_anonymous || session.user.id !== accountId || getStoredSyncId() !== syncId || getRemoteSyncConfig()?.url !== config?.url || getRemoteSyncConfig()?.anonKey !== config?.anonKey) throw new Error('接続が変わりました。内容を確認し直してください。');
        const db = await openAppDb();
        return exportRecordConflictOriginals(current, await readActiveRecordConflicts(db, connection()));
      }, { requireCrossContext: true });
      await saveJsonBackup(`quiz-make-conflict-originals-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`, raw);
      setExportMessage('両候補の原本を保存しました。');
    } catch (caught) { setExportError(caught instanceof Error ? caught.message : '原本を保存できませんでした。'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const rows = (all: boolean) => comparison?.differences.slice(all ? 3 : 0, all ? undefined : 3).map((row, i) => <div className="sync-difference" key={`${row.label}-${i}`}>
    <strong>{row.label}</strong><dl><div><dt>この端末</dt><dd>{row.local}</dd></div><div><dt>クラウド</dt><dd>{row.remote}</dd></div></dl>
  </div>);
  return <>
    {conflicts.length ? <button type="button" className="sync-button sync-button--primary sync-review-entry" onClick={() => onOpenChange(true)}>確認する</button> : null}
    {error && !open ? <div className="sync-overview-error"><p role="alert">変更の内容を確認できません。未送信の変更は保持しています。</p><button type="button" className="sync-button" onClick={() => setAttempt(n => n + 1)}>再試行</button><details><summary>詳細</summary>{error}</details></div> : null}
    {open ? <section ref={dialogRef} tabIndex={-1} className="sync-review-screen" role="dialog" aria-modal="true" aria-label="変更の内容を確認">
      <header><button type="button" className="sync-button" disabled={busy} onClick={() => onOpenChange(false)}>戻る</button><h2>変更の内容を確認</h2><button type="button" className="sync-button" disabled={busy} onClick={() => onOpenChange(false)}>閉じる</button></header>
      <main>
        {conflicts.length > 1 ? <p>{index + 1} / {conflicts.length}</p> : null}
        {current ? <fieldset disabled={busy} key={current.key}>
          <legend>{titles[current.key] ?? '変更内容'}</legend>
          {rows(false)}
          {comparison?.incomplete ? <p className="sync-review-note">表示できない違いがあります。詳細の原本で内容を確認してください。</p> : null}
          <label><input type="radio" name="record-version" checked={choices[current.key] === 'local'} onChange={() => setChoices(value => ({ ...value, [current.key]: 'local' }))} /><strong>この端末を使う</strong><span>{comparison?.local}</span></label>
          <label><input type="radio" name="record-version" checked={choices[current.key] === 'remote'} onChange={() => setChoices(value => ({ ...value, [current.key]: 'remote' }))} /><strong>クラウドを使う</strong><span>{comparison?.remote}</span></label>
          {conflicts.length > 1 ? <div className="sync-actions"><button className="sync-button" disabled={busy || index === 0} onClick={() => setIndex(n => n - 1)}>前の変更</button><button className="sync-button" disabled={busy || index >= conflicts.length - 1} onClick={() => setIndex(n => n + 1)}>次の変更</button></div> : null}
        </fieldset> : <p>確認が必要な変更はありません。</p>}
        {error ? <><p role="alert">内容を確定できません。もう一度確認してください。</p><details><summary>詳細</summary>{error}</details></> : null}
        <div className="sync-actions"><button className="sync-button sync-button--primary" disabled={busy || !current || remaining > 0 || Boolean(error)} onClick={() => void resolve()}>{busy ? '処理中…' : '選んだ内容を確定'}</button><button className="sync-button" disabled={busy} onClick={() => onOpenChange(false)}>あとで</button></div>
        {current ? <details className="sync-review-details" key={`details:${current.key}`}><summary>詳細{comparison && comparison.differences.length > 3 ? `（ほか${comparison.differences.length - 3}件の違い）` : ''}</summary>
          {comparison && comparison.differences.length > 3 ? rows(true) : null}
          <p>選択はこの項目全体に適用されます。選ばなかった原本も端末に残します。</p>
          {current.remote.collection === 'localStorage' ? <p>保存項目：{conflictPreview(current.remote.id)}</p> : null}
          <p>端末 {current.local?.raw?.length ?? 0}文字 / クラウド {current.remote.raw?.length ?? 0}文字</p>
          <p>両候補は選択前に保存できます。個人の内容を含む確認用ファイルです。通常のバックアップ復元には使えません。</p>
          <button className="sync-button" disabled={busy} onClick={() => void saveOriginals()}>両候補の原本を保存</button>
          {exportError ? <p role="alert">{exportError}</p> : null}{exportMessage ? <p role="status">{exportMessage}</p> : null}
          {onOpenBackups ? <button className="sync-button" disabled={busy} onClick={() => { onOpenChange(false); onOpenBackups(); }}>バックアップを開く</button> : null}
        </details> : null}
      </main>
    </section> : null}
  </>;
}
