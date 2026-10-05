import { useEffect, useMemo, useState } from 'react';
import { accountLocalStorage, getAccountStorageSession, sameLocalAccount } from '../utils/accountStorage';
import { getCachedCloudAccountIdentity, getCloudAccessToken } from '../utils/cloudService';
import { adoptUnclaimedLegacyData, hasPreservedLegacyData } from '../utils/accountLegacyAdoption';
import { getStoredSyncId } from '../utils/syncService';
import { withCoordinatedDataRead } from '../utils/dataCoordination';
import { archivedLegacyOwnedBy, createUnionCloudReader, readActiveUnionLocal, readArchivedUnionLocal, readOwnedUnionCloud, readUnionImage, settleUnionSourceSend, type UnionCloudReader } from '../utils/accountUnionSource';
import { activateUnionMigration, createUnionMigration, prepareUnionMigration, previewUnionMigration, readUnionMigrations, rollbackUnionMigration, saveUnionChoices, type UnionJournal } from '../utils/accountUnionJournal';
import { unionFingerprint, type UnionChoice, type UnionSnapshot } from '../utils/accountUnionPlan';
import type { AccountSyncState } from '../utils/accountSync';
import './AccountUnionPanel.css';
type Props = { state: AccountSyncState; open: boolean; onOpenChange(open: boolean): void; onBusyChange(busy: boolean): void };
function content(raw: string | null): string {
  if (raw === null) return '削除済み';
  try { const v = JSON.parse(raw); return typeof v.question === 'string' ? [v.question, ...(v.choices ?? []), v.explanation].filter(Boolean).join('\n') : JSON.stringify(v, null, 2); } catch { return raw; }
}
export function AccountUnionPanel({ state, open, onOpenChange, onBusyChange }: Props) {
  const [entry, setEntry] = useState<UnionJournal | null>(null), [saved, setSaved] = useState<UnionJournal[]>([]), [sourceId, setSourceId] = useState('');
  const [legacy, setLegacy] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmedDelete, setConfirmedDelete] = useState(false);
  const [candidates,setCandidates]=useState<Array<{syncId:string;updatedAt:string}>>([]);
  const [preserved, setPreserved] = useState(false);
  const owner = getAccountStorageSession(), destinationId = state.syncId;
  const assertCurrent = () => { if (!owner?.identity || !sameLocalAccount(owner.identity, getCachedCloudAccountIdentity())) throw new Error('アカウントが変わりました。元の控えは保持しています。'); owner.assertNetworkCurrent(owner.identity); };
  const comparison = useMemo(() => { try { return { preview: entry && entry.phase === 'draft' ? previewUnionMigration(entry) : null, error: '' }; } catch (e) { return { preview: null, error: e instanceof Error ? e.message : '保存した確認内容を読み取れません。' }; } }, [entry]);
  const preview = comparison.preview;
  const remember = (next: UnionJournal) => { setEntry(next); setSaved(rows => [next, ...rows.filter(row => row.id !== next.id)]); };
  useEffect(() => { if (!open || !owner?.identity) return; let stopped = false;
    try { setLegacy(archivedLegacyOwnedBy(globalThis.localStorage, owner.identity)); const id = getStoredSyncId(); if (id !== destinationId) setSourceId(id); accountLocalStorage.removeItem('quizMake:sync:unionLegacyPending');
      const raw=accountLocalStorage.getItem('quizMake:sync:ownedCandidates:v1'),saved=raw?JSON.parse(raw):null;
      if(saved&&sameLocalAccount(saved.identity,owner.identity)&&Array.isArray(saved.choices))setCandidates(saved.choices.filter((row:{syncId:string;updatedAt:string})=>/^[a-f0-9]{36}$/u.test(row.syncId)&&row.syncId!==destinationId&&Number.isFinite(Date.parse(row.updatedAt))));
    } catch { setError('保管した端末データを確認できません。'); }
    void readUnionMigrations(indexedDB, globalThis.localStorage, owner.identity).then(rows => { if (!stopped) setSaved(rows); }).catch(() => { if (!stopped) setError('統合の控えを確認できません。'); }); return () => { stopped = true; };
  }, [open, owner, destinationId]);
  const run = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); onBusyChange(true); setError(''); try { assertCurrent(); await operation(); } catch (e) { setError(e instanceof Error ? e.message : '統合を完了できません。両方の原本は保持しています。'); } finally { setBusy(false); onBusyChange(false); } };
  const recheck = (reader: UnionCloudReader) => async (snapshot: UnionSnapshot) => { const latest = await readOwnedUnionCloud(reader, snapshot.syncId!, snapshot.label); if (await unionFingerprint(latest) !== await unionFingerprint(snapshot)) throw new Error('保存先の内容が更新されました。新しいプレビューを作成してください。以前の控えは残ります。'); };
  const local = () => readActiveUnionLocal(assertCurrent);
  useEffect(() => { if (!open) return; let stopped = false;
    void withCoordinatedDataRead([], () => hasPreservedLegacyData(indexedDB, globalThis.localStorage), { requireCrossContext: true }).then(value => { if (!stopped) setPreserved(value); }).catch(() => { if (!stopped) setError('保管した旧端末領域を確認できません。原本は保持しています。'); }); return () => { stopped = true; };
  }, [open]);
  const selectPreserved = () => run(async () => { if (!owner?.identity) return; const access = await getCloudAccessToken(); assertCurrent();
    if (!access.ok || access.userId !== owner.identity.userId) throw new Error('端末データを取り込むアカウントを確認できません。原本は保持しています。');
    await adoptUnclaimedLegacyData(indexedDB, globalThis.localStorage, owner.identity, assertCurrent); assertCurrent();
    accountLocalStorage.removeItem('quizMake:sync:unionLegacyPending'); setLegacy(true); setPreserved(false); setEntry(null); setConfirmedDelete(false);
  });
  const makePreview = () => run(async () => {
    if (!owner?.identity || !destinationId) throw new Error('アカウントの保存先を確認してから統合してください。');
    const reader = await createUnionCloudReader(), current = await withCoordinatedDataRead(['app', 'notes'], local, { requireCrossContext: true });
    const destination = await readOwnedUnionCloud(reader, destinationId, 'アカウントの保存先'), sources: UnionSnapshot[] = [];
    if (legacy) sources.push(await withCoordinatedDataRead([], () => readArchivedUnionLocal(indexedDB, globalThis.localStorage, owner.identity!, assertCurrent), { requireCrossContext: true }));
    else if (sourceId && sourceId !== destinationId) sources.push(await readOwnedUnionCloud(reader, sourceId, '選択した以前の保存先'));
    sources.push(current); assertCurrent(); const draft = await createUnionMigration(indexedDB, globalThis.localStorage, owner, current, destination, sources, assertCurrent);
    remember(draft); setConfirmedDelete(false);
  });
  const choose = (key: string, choice: UnionChoice) => run(async () => { if (!entry) return; const step = Number(key.split(':')[0]), choices = { ...Object.fromEntries(Object.entries(entry.choices).filter(([k]) => Number(k.split(':')[0]) <= step)), [key]: choice };
    remember(await saveUnionChoices(indexedDB, entry, choices, assertCurrent)); setConfirmedDelete(false);
  });
  const apply = () => run(async () => { if (!entry) return; const reader = await createUnionCloudReader(), deps = { assertCurrent, readLocal: local, recheckCloud: recheck(reader), readImage: (row: Parameters<typeof readUnionImage>[0]) => readUnionImage(row, assertCurrent) };
    const prepared = await withCoordinatedDataRead(['app', 'notes'], () => prepareUnionMigration(indexedDB, globalThis.localStorage, entry, deps, confirmedDelete), { requireCrossContext: true }); remember(prepared);
    await withCoordinatedDataRead(['app', 'notes'], () => activateUnionMigration(indexedDB, globalThis.localStorage, prepared, deps), { requireCrossContext: true }); window.location.reload();
  });
  const resume = () => run(async () => { if (!entry) return; const reader = await createUnionCloudReader(); await withCoordinatedDataRead(['app', 'notes'], () => activateUnionMigration(indexedDB, globalThis.localStorage, entry, { assertCurrent, readLocal: local, recheckCloud: recheck(reader) }), { requireCrossContext: true }); window.location.reload(); });
  const rollback = () => run(async () => { if (!entry || !owner) return; await owner.withExclusiveUnionWindow(() => withCoordinatedDataRead(['app', 'notes'], () => rollbackUnionMigration(indexedDB, globalThis.localStorage, entry, assertCurrent), { requireCrossContext: true })); window.location.reload(); });
  const download = () => { if (!entry) return; assertCurrent(); const url = URL.createObjectURL(new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = 'QuizMake-union-originals-' + entry.id + '.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <section className="sync-section account-union"><button className="sync-subpage-row" disabled={busy} onClick={() => onOpenChange(!open)}>以前の教材・履歴をまとめる<span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button>
    {open ? <div className="account-union__body"><p>同じアカウントが所有する保存先と端末データを比較します。両方の原本と回答IDを保持し、違いを確認してから統合します。</p><p>文章一致ではまとめません。個人の計画・学習日のタイムゾーン・保存済み日次目標を勝手に変更しません。</p>
      {!legacy && preserved ? <div><p>以前「保管のみ」を選んだ、未所属の旧端末データがあります。選ぶとこのアカウントの原本として保管し、統合内容の確認へ進みます。</p><button className="sync-button" disabled={busy} onClick={selectPreserved}>保管した旧端末データを統合元に選ぶ</button></div> : null}
      {legacy ? <p>このアカウント用に保管した端末データが対象です。</p> : <>
        {candidates.length?<label className="sync-label">同じアカウントの以前の保存先<select className="sync-input" disabled={busy} value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">この端末のデータだけ</option>{candidates.map((row,i)=><option key={row.syncId} value={row.syncId}>保存先 {i+1}（最終保存 {new Date(row.updatedAt).toLocaleString('ja-JP')}）</option>)}</select></label>:null}
        <details><summary>別の端末で使っていた保存先を指定</summary><label className="sync-label">以前の保存先ID（この端末だけを含める場合は空欄）<input className="sync-input" value={sourceId} onChange={e => setSourceId(e.target.value.trim())} disabled={busy} autoComplete="off" /></label></details>
        {sourceId?<p>選択した以前の保存先と、この端末の原本を含めます。所有者を再確認してから読み込みます。</p>:null}
      </>}
      <button className="sync-button" disabled={busy || !destinationId} onClick={makePreview}>新しく統合内容を確認</button>
      {saved.length ? <label className="sync-label">保存した確認内容<select className="sync-input" disabled={busy} value={entry?.id ?? ''} onChange={e => { setEntry(saved.find(row => row.id === e.target.value) ?? null); setConfirmedDelete(false); }}><option value="">控えを選ぶ</option>{saved.map(row => <option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString('ja-JP')}・{row.phase === 'activated' ? '統合済み' : row.phase === 'rolled_back' ? '元に戻した' : '確認中'}</option>)}</select></label> : null}
      {preview ? <><h3>統合内容の確認 {preview.step + 1}/{preview.totalSteps}</h3><p>追加 {preview.added}件・同じ記録 {preview.deduplicated}件・未選択 {preview.unresolved}件</p>{preview.warnings.map(text => <p key={text}>{text}</p>)}
        {preview.conflicts.map(conflict => <fieldset key={conflict.key} className="account-union__conflict"><legend>{conflict.kind === 'delete-edit' ? '削除と編集の確認' : conflict.kind === 'progress' ? '学習状態の確認' : '内容の違いを確認'}</legend>{(['destination', 'source'] as const).map(side => <label key={side}><input type="radio" name={conflict.key} checked={entry?.choices[conflict.key] === side} disabled={busy} onChange={() => choose(conflict.key, side)} />{side === 'destination' ? '統合先の内容を残す' : '取り込む側の内容を残す'}<pre>{content(conflict[side].raw)}</pre></label>)}</fieldset>)}
        {preview.dependentDeletions.length ? <label><input type="checkbox" checked={confirmedDelete} disabled={busy} onChange={e => setConfirmedDelete(e.target.checked)} />削除に伴う教材・回答履歴 {preview.dependentDeletions.length}件を確認しました。原本の控えは残ります。</label> : null}
        <button className="sync-button sync-button--primary" disabled={busy || preview.unresolved > 0 || Boolean(preview.dependentDeletions.length && !confirmedDelete)} onClick={apply}>確認した内容で統合する</button></> : null}
      {entry?.phase === 'prepared' ? <><p>統合先の準備が保存されています。原本は変更していません。</p><button className="sync-button" disabled={busy} onClick={resume}>準備した統合を再開</button></> : null}
      {entry?.phase === 'activated' ? <><p>元の端末領域に戻しても、クラウドへ反映済みの統合は取り消しません。新しい学習や未確認送信がある場合は巻き戻しを止めます。</p><button className="sync-button" disabled={busy} onClick={rollback}>元の端末領域へ戻す</button></> : null}
      {entry ? <button className="sync-button" disabled={busy} onClick={download}>両方の原本と選択を保存</button> : null}{busy ? <p role="status">原本と保存先を確認しています…</p> : null}{error || comparison.error ? <p role="alert">{error || comparison.error}</p> : null}
      {error.includes('未確認')?<button className="sync-button" disabled={busy} onClick={()=>run(async()=>{await withCoordinatedDataRead(['app','notes'],settleUnionSourceSend,{requireCrossContext:true});setError('元の送信結果を確認しました。新しく統合内容を確認してください。');})}>元の送信結果を確認</button>:null}
    </div> : null}</section>;
}
