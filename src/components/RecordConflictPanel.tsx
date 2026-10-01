import { useEffect, useRef, useState } from 'react';
import { getCloudAccessToken } from '../utils/cloudService';
import { withCoordinatedDataMutation, withCoordinatedDataRead } from '../utils/dataCoordination';
import { replayLocalStorageProjections } from '../utils/localStorageRecords';
import { readAppRecordSnapshot } from '../utils/appRecordStorage';
import { applyStagedRecordPull, readActiveRecordConflicts, type RecordConflict, type RecordConflictDecision } from '../utils/recordSyncPull';
import { describeRecordConflictValue, recordConflictIdentity, recordConflictTitle, retainRecordConflictChoices } from '../utils/recordConflictPresentation';
import { getRemoteSyncConfig, getStoredSyncId, waitForLocalPersistence } from '../utils/syncService';
import { openAppDb } from '../storage';

export function RecordConflictPanel({ syncId, accountId, onImported }: {
  syncId: string; accountId: string; onImported?: () => Promise<void>;
}) {
  const [conflicts, setConflicts] = useState<RecordConflict[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, 'local' | 'remote'>>({});
  const [busy, setBusy] = useState(false);
  const [automaticPending, setAutomaticPending] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const identitiesRef = useRef(new Map<string, string>());
  const connection = () => {
    const config = getRemoteSyncConfig();
    if (!config) throw new Error('同期先が設定されていません。');
    return { project: new URL(config.url).origin, userId: accountId, syncId };
  };
  useEffect(() => {
    let stopped = false;
    let loading = false;
    let inspection: { signature: string; visible: RecordConflict[] } | null = null;
    setAutomaticPending(false);
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
          const result = await withCoordinatedDataRead(['app', 'notes'], async () => {
            if (stopped || getStoredSyncId() !== syncId) return null;
            // Recover old false conflicts using the same backend merge as auto
            // sync. Rebase metadata only; visible changes still wait for Home.
            return applyStagedRecordPull(db, connection(), [], { preserveLiveData: true });
          }, { requireCrossContext: true });
          if (result) {
            const visible = !result.applied && 'conflicts' in result ? result.conflicts : [];
            const active = await readActiveRecordConflicts(db, connection());
            snapshot = await readAppRecordSnapshot(db);
            inspection = { signature: JSON.stringify([snapshot?.state.commitId, active.map(recordConflictIdentity)]), visible };
            found = visible;
            if (!stopped) setAutomaticPending(!visible.length);
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
        if (!stopped) setError(caught instanceof Error ? caught.message : '同期の差分を確認できませんでした。');
      } finally { loading = false; }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [syncId, accountId]);
  const resolve = async () => {
    if (busyRef.current || conflicts.some(item => !choices[item.key])) return;
    busyRef.current = true;
    setBusy(true); setError('');
    try {
      if (getStoredSyncId() !== syncId) throw new Error('同期先が変わりました。');
      const access = await getCloudAccessToken();
      if (!access.ok || access.userId !== accountId) throw new Error('ログイン状態が変わりました。');
      const saved = await waitForLocalPersistence();
      if (!saved.ok) throw new Error(saved.error);
      const selected: RecordConflictDecision[] = conflicts.map(item => ({
        key: item.key, operationId: item.operationId!, remoteRevision: item.remote.revision, choice: choices[item.key],
      }));
      const applied = await withCoordinatedDataMutation(['app', 'notes'], async () => {
        if (getStoredSyncId() !== syncId) throw new Error('同期先が変わりました。');
        const result = await applyStagedRecordPull(await openAppDb(), connection(), selected);
        if (result.applied) await replayLocalStorageProjections();
        return result;
      }, { requireCrossContext: true });
      if (!applied.applied) throw new Error('競合内容が更新されました。もう一度確認してください。');
      setConflicts([]); setChoices({}); setAutomaticPending(false);
      await onImported?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '変更を確定できませんでした。'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  if (!conflicts.length) return automaticPending || error ? <section className="sync-card" aria-live="polite">
    {automaticPending ? <p>安全に統合できる差分を確認しました。ホームに戻ると反映・送信を再開します。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section> : null;
  return <section className="sync-card" aria-label="変更内容の確認">
    <h2>確認が必要な変更：{conflicts.length}件</h2>
    <p>自動で統合できる回答は選択不要です。ここには、異なる編集や履歴だけでは判断できない変更を表示しています。両方の内容は端末に保存され、選ばなかった内容も回復用に残ります。</p>
    {conflicts.map(item => <fieldset key={item.key} disabled={busy}>
      <legend>{titles[item.key] ?? '変更内容'}</legend>
      <label><input type="radio" name={item.key} checked={choices[item.key] === 'local'}
        onChange={() => setChoices(current => ({ ...current, [item.key]: 'local' }))} />端末：{describeRecordConflictValue(item.local?.raw ?? null)}</label>
      <label><input type="radio" name={item.key} checked={choices[item.key] === 'remote'}
        onChange={() => setChoices(current => ({ ...current, [item.key]: 'remote' }))} />クラウド：{describeRecordConflictValue(item.remote.raw)}</label>
    </fieldset>)}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" className="sync-button sync-button--primary" disabled={busy || conflicts.some(item => !choices[item.key])}
      onClick={() => void resolve()}>{busy ? '確定中…' : '選んだ内容を確定'}</button>
  </section>;
}
