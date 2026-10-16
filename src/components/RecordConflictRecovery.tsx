import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openAppDb } from '../storage';
import { getCloudSession, onCloudAuthStateChange } from '../utils/cloudService';
import { getRemoteSyncConfig, getStoredSyncId, exportQuizMakeData } from '../utils/syncService';
import { readAppRecordSnapshot } from '../utils/appRecordStorage';
import { createConflictRecoveryCopy, readArchivedRecordConflicts, restoreRecoveredRecord, markRecoveredOriginalReviewed, listProtectedOriginals, readProtectedOriginal, type ArchivedRecordConflict } from '../utils/recordConflictRecovery';
import { recordConflictTitle } from '../utils/recordConflictPresentation';
import { saveBackupPayload } from '../utils/backupRepository';
import { saveJsonBackup } from '../utils/nativePlatform';

export function RecordConflictRecovery({ onCreated, onBusyChange }: { onCreated: () => Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const [items, setItems] = useState<Array<ArchivedRecordConflict & { title: string }>>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const lock = useRef(false);
  const [account, setAccount] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(50);
  const [originals,setOriginals]=useState<string[]>([]);
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
    setItems([]); setOriginals([]); setMessage(''); setError('');
    if (!config || !account || !syncId) return;
    void (async () => {
      const db = await openAppDb();
      const archives = await readArchivedRecordConflicts(db, { project: new URL(config.url).origin, userId: account, syncId });
      const snapshot = await readAppRecordSnapshot(db);
      const protectedOriginals=await listProtectedOriginals(db);
      if(!stopped)setOriginals(protectedOriginals);
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
    {!items.length && !originals.length && !error ? <p>保存された競合の原本はありません。</p> : null}
    {!!items.length&&<label>項目を検索<input value={query} onChange={event=>{setQuery(event.target.value);setLimit(50);}} placeholder="問題・ノートの名前やID" /></label>}
    {items.filter(item=>(item.title+' '+item.conflict.key).includes(query)).slice(0,limit).map(item => <details key={item.id}>
      <summary>{item.title} {item.savedAt ? new Date(item.savedAt).toLocaleString('ja-JP') : ''}</summary>
      <p>保存した原本を確認できます。復元を選んだ場合は新しい編集として同期されます。</p>
      <div className="sync-actions">
        <button className="sync-button" disabled={busy} onClick={()=>void run(async()=>{const db=await openAppDb();await restoreRecoveredRecord(db,item.conflict,'local');await markRecoveredOriginalReviewed(db,item.id);await onCreated();setAttempt(n=>n+1);setMessage('選んだ版を新しい編集として復元しました。');})}>保存した版を復元</button>
        <button className="sync-button" disabled={busy} onClick={()=>void run(async()=>{await markRecoveredOriginalReviewed(await openAppDb(),item.id);setAttempt(n=>n+1);setMessage('確認済みにしました。原本は保持しています。');})}>確認済みにする</button>
        {(['local', 'remote'] as const).map(side => <button key={side} className="sync-button" disabled={busy} onClick={() => void run(async () => {
          const payload = await exportQuizMakeData();
          const raw = payload.localStorage['quiz-make-app-data-v1'];
          if (!raw) throw new Error('現在の問題データを確認できません。');
          const copy = createConflictRecoveryCopy(JSON.parse(raw), item.conflict, side);
          await saveBackupPayload({ ...payload, localStorage: { ...payload.localStorage, 'quiz-make-app-data-v1': JSON.stringify(copy) } }, 'before-sync');
          await onCreated();
          setMessage('復旧コピーを含むバックアップを作成しました。内容を確認して復元できます。');
        })}>{side === 'local' ? '端末版' : 'クラウド版'}の復旧コピーを作成</button>)}
        <button className="sync-button" disabled={busy} onClick={() => void run(async () => {
          const copy=structuredClone(item),db=await openAppDb(),{unpackBlobNote}=await import('../utils/blobVault'),{downloadContentBlob}=await import('../utils/blobCloud');
          for(const row of [copy.conflict.local,copy.conflict.remote])if(row?.raw)row.raw=await unpackBlobNote(db,row.raw,downloadContentBlob);
          await saveJsonBackup(`quiz-make-conflict-originals-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`, JSON.stringify(copy, null, 2)); setMessage('両原本を書き出しました。'); })}>両原本のJSONを書き出す</button>
      </div>
    </details>)}
    {items.filter(item=>(item.title+' '+item.conflict.key).includes(query)).length>limit&&<button onClick={()=>setLimit(n=>n+50)}>さらに50件を表示</button>}
    {!!originals.length&&<details><summary>旧保存領域・ノートの救出原本（{originals.length}件）</summary><p>切り替え前に保護した内容です。本文を含むJSONを書き出して確認できます。</p>{originals.filter(id=>id.includes(query)).slice(0,limit).map(id=><p key={id}><code>{id}</code> <button disabled={busy} onClick={()=>void run(async()=>{const raw=await readProtectedOriginal(await openAppDb(),id);await saveJsonBackup(`quiz-make-rescue-${Date.now()}.json`,raw);setMessage('救出原本を書き出しました。');})}>原本を書き出す</button></p>)}{originals.filter(id=>id.includes(query)).length>limit&&<button onClick={()=>setLimit(n=>n+50)}>さらに50件を表示</button>}</details>}
  </section>;
}
