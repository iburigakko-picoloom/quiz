import { AccountStorageSession, accountGenerationKey, accountNamespace, readAccountGeneration, sameLocalAccount, type LocalAccountIdentity } from './accountStorage';
import { APP_COLLECTIONS, upgradeAppRecordStores, type AppOutboxOperation, type AppRecord, type AppRecordState } from './appRecordStorage';
import { previewAccountUnion, unionFingerprint, validateUnionSnapshot, type UnionChoice, type UnionPreview, type UnionRecord, type UnionSnapshot } from './accountUnionPlan';
import { validatePlanStorage } from './studyPlanStorage';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { verifyQuestionImageBlob } from './questionImageCloud';
import type { StoredQuestionImage } from './questionImageRecords';
import { isChunkInternal } from './recordChunkFormat';
import { CATEGORY_NOTES_MANIFEST_KEY, isValidCategoryNoteRaw } from './noteStorage';

export type UnionJournal = {
  schema: 1; id: string; revision: number; identity: LocalAccountIdentity; createdAt: string; phase: 'draft' | 'prepared' | 'activated' | 'rolled_back';
  previousGeneration: string | null; generation: string; localFingerprint: string; destination: UnionSnapshot; sources: UnionSnapshot[];
  localSettings: Record<string, string>; choices: Record<string, UnionChoice>; preparedFingerprint?: string; preparedCommitId?: string;
};
export type UnionMigrationPreview = UnionPreview & { step: number; totalSteps: number };
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('統合用の控えを保存できませんでした。原本は保持しています。')); });
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
function validateJournal(entry: UnionJournal) {
  if (entry.schema !== 1 || !entry.id || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !Number.isFinite(Date.parse(entry.createdAt)) || !/^union-[a-f0-9-]{36}$/u.test(entry.generation) || entry.generation === entry.previousGeneration || entry.destination.kind !== 'cloud') throw new Error('統合の所有記録を確認できません。');
  [entry.destination, ...entry.sources].forEach(snapshot => validateUnionSnapshot(snapshot, entry.identity));
}
function contentFingerprint(entry: UnionJournal, records: UnionRecord[]) {
  return unionFingerprint({ ...entry.destination, kind: 'local', head: 0, records: records.filter(row => !isChunkInternal(row.collection, row.id))
    .map(row => ({ key: row.key, collection: row.collection, id: row.id, raw: row.raw, position: row.position, revision: 0 })) });
}
async function journalDb(factory: IDBFactory, identity: LocalAccountIdentity) {
  return new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open('quiz-make-account-union-v1:' + accountNamespace(identity), 1); r.onupgradeneeded = () => r.result.createObjectStore('migrations', { keyPath: 'id' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function saveJournal(factory: IDBFactory, entry: UnionJournal, assertCurrent: () => void) {
  assertCurrent(); const db = await journalDb(factory, entry.identity);
  try { assertCurrent(); const tx = db.transaction('migrations', 'readwrite'), completion = done(tx), store = tx.objectStore('migrations'), old = store.get(entry.id); let failure: unknown;
    old.onsuccess = () => { try { assertCurrent(); if ((old.result?.revision ?? 0) + 1 !== entry.revision) throw new Error('別の画面で統合の選択が更新されました。控えを開き直してください。'); store.put(entry); } catch (error) { failure = error; tx.abort(); } };
    try { await completion; } catch (error) { throw failure ?? error; } assertCurrent();
  } finally { db.close(); }
}
async function assertSavedJournal(factory: IDBFactory, native: Storage, entry: UnionJournal, assertCurrent: () => void) {
  assertCurrent(); const db = await journalDb(factory, entry.identity);
  try { const tx = db.transaction('migrations'), completion = done(tx), row = tx.objectStore('migrations').get(entry.id); await completion; assertCurrent();
    const stored = row.result as UnionJournal | undefined;
    const effective = stored && readAccountGeneration(native, entry.identity) === stored.generation ? { ...stored, phase: 'activated' as const } : stored;
    if (!effective || JSON.stringify(effective) !== JSON.stringify(entry)) throw new Error('別の画面で統合の選択が更新されました。控えを開き直してください。');
  } finally { db.close(); }
}
export async function readUnionMigrations(factory: IDBFactory, native: Storage, identity: LocalAccountIdentity): Promise<UnionJournal[]> {
  const db = await journalDb(factory, identity);
  try { const tx = db.transaction('migrations'), completion = done(tx); const rows = await request<UnionJournal[]>(tx.objectStore('migrations').getAll()); await completion;
    return rows.filter(row => row.schema === 1 && sameLocalAccount(row.identity, identity)).map(row => readAccountGeneration(native, identity) === row.generation ? { ...row, phase: 'activated' as const } : row).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally { db.close(); }
}
export function previewUnionMigration(entry: UnionJournal, choices = entry.choices): UnionMigrationPreview {
  validateJournal(entry);
  let destination = entry.destination, final: UnionPreview | undefined;
  let added = 0, deduplicated = 0; const conflicts: UnionPreview['conflicts'] = [], warnings: string[] = [], deleted: UnionRecord[] = [];
  for (let step = 0; step < entry.sources.length; step++) {
    const prefix = `${step}:`, selected = Object.fromEntries(Object.entries(choices).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
    final = previewAccountUnion(destination, entry.sources[step], selected);
    conflicts.push(...final.conflicts.map(row => ({ ...row, key: prefix + row.key })));
    added += final.added; deduplicated += final.deduplicated; warnings.push(...final.warnings); deleted.push(...final.dependentDeletions);
    if (final.unresolved) return { ...final, conflicts, added, deduplicated, warnings: [...new Set(warnings)], dependentDeletions: deleted, step, totalSteps: entry.sources.length };
    destination = { ...entry.destination, kind: 'local', records: final.records };
  }
  if (!final) throw new Error('統合元が指定されていません。');
  if (Object.keys(choices).some(key => !conflicts.some(row => row.key === key))) throw new Error('古い競合の選択です。内容を確認し直してください。');
  return { ...final, conflicts, added, deduplicated, warnings: [...new Set(warnings)], dependentDeletions: deleted, step: entry.sources.length - 1, totalSteps: entry.sources.length };
}
export async function createUnionMigration(factory: IDBFactory, native: Storage, owner: AccountStorageSession,
  local: UnionSnapshot, destination: UnionSnapshot, sources: UnionSnapshot[], assertCurrent: () => void): Promise<UnionJournal> {
  assertCurrent(); owner.assertCurrent(); if (!owner.identity || !sameLocalAccount(owner.identity, destination.identity)) throw new Error('所有アカウントを確認できません。');
  [local, destination, ...sources].forEach(snapshot => validateUnionSnapshot(snapshot, owner.identity!));
  const localSettings: Record<string, string> = {};
  for (let i = 0; i < owner.storage.length; i++) { const key = owner.storage.key(i); if (key) { const raw = owner.storage.getItem(key); if (raw !== null) localSettings[key] = raw; } }
  const entry: UnionJournal = { schema: 1, revision: 1, id: crypto.randomUUID(), identity: owner.identity, createdAt: new Date().toISOString(), phase: 'draft',
    previousGeneration: readAccountGeneration(native, owner.identity), generation: 'union-' + crypto.randomUUID(), localFingerprint: await unionFingerprint(local),
    destination: structuredClone(destination), sources: structuredClone(sources), localSettings, choices: {} };
  assertCurrent(); await saveJournal(factory, entry, assertCurrent); return entry;
}
export async function saveUnionChoices(factory: IDBFactory, entry: UnionJournal, choices: Record<string, UnionChoice>, assertCurrent: () => void) {
  if (entry.phase !== 'draft') throw new Error('準備済みの統合内容は変更できません。新しくプレビューしてください。');
  previewUnionMigration(entry, choices);
  const next = { ...entry, revision: entry.revision + 1, choices: { ...choices } }; await saveJournal(factory, next, assertCurrent); return next;
}
export async function openUnionStage(factory: IDBFactory, owner: AccountStorageSession): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const r = factory.open(owner.databaseName('quiz-make-app-data-v1'), 7); let failed = false;
    r.onupgradeneeded = () => { upgradeAppRecordStores(r.result); if (!r.result.objectStoreNames.contains('appDataBackups')) r.result.createObjectStore('appDataBackups'); };
    r.onsuccess = () => { if (failed) r.result.close(); else resolve(r.result); }; r.onerror = () => reject(r.error); r.onblocked = () => { failed = true; reject(new Error('統合用の保存領域を開けません。ほかの画面を閉じてください。')); }; });
}
export type UnionPreparation = { assertCurrent(): void; readLocal(): Promise<UnionSnapshot>; recheckCloud(snapshot: UnionSnapshot): Promise<void>; readImage(row: UnionRecord): Promise<StoredQuestionImage> };
/** Never edits the active store. Restart repeats this deterministic staging
 * write; source snapshots and choices are already durably saved in the journal. */
export async function prepareUnionMigration(factory: IDBFactory, native: Storage, entry: UnionJournal, deps: UnionPreparation, confirmDependentDeletions = false): Promise<UnionJournal> {
  deps.assertCurrent(); validateJournal(entry);
  await assertSavedJournal(factory, native, entry, deps.assertCurrent);
  if (entry.phase !== 'draft' && entry.phase !== 'prepared') throw new Error('この移行は準備できません。');
  if (readAccountGeneration(native, entry.identity) !== entry.previousGeneration) throw new Error('端末の保存先が変わりました。原本は保持しています。');
  if (await unionFingerprint(await deps.readLocal()) !== entry.localFingerprint) throw new Error('プレビュー後に端末データが変わりました。内容を確認し直してください。');
  for (const snapshot of [entry.destination, ...entry.sources]) if (snapshot.kind === 'cloud') { await deps.recheckCloud(snapshot); deps.assertCurrent(); }
  const preview = previewUnionMigration(entry);
  if (preview.unresolved || !preview.data) throw new Error('競合する両方の候補から、残す内容を選んでください。');
  if (preview.dependentDeletions.length && !confirmDependentDeletions) throw new Error('削除に伴う教材・回答履歴の対象を確認してください。原本の控えは残します。');
  for (const row of preview.records) if (row.raw !== null) {
    if (row.collection === 'localStorage') validatePlanStorage(row.id, row.raw);
    if (row.collection === 'indexedDbNotes' && (!row.id.startsWith('quizMake:notes:') || !isValidCategoryNoteRaw(row.raw))) throw new Error('ノートの原本を完全に検証できません。');
  }
  const staged = new AccountStorageSession(native, { identity: entry.identity, namespace: accountNamespace(entry.identity), legacyUnclaimed: false }, { generation: entry.generation, staging: true });
  const images: StoredQuestionImage[] = [];
  for (const row of preview.records) if (row.collection === 'questionImages' && row.raw) {
    const descriptor = parseQuestionImageDescriptor(row.raw), image = await deps.readImage(row); deps.assertCurrent();
    if (image.id !== descriptor.id || image.questionId !== descriptor.questionId || !await verifyQuestionImageBlob(image.blob, descriptor)) throw new Error('問題画像の本体を検証できません。原本は保持しています。');
    images.push(image);
  }
  deps.assertCurrent();
  await assertSavedJournal(factory, native, entry, deps.assertCurrent);
  // App-specific display settings come only from the active local account.
  const project = (key: string, value: string | null) => { if (value === null) staged.storage.removeItem(key); else staged.storage.setItem(key, value); if (staged.storage.getItem(key) !== value) throw new Error('統合先の計画・設定を保存できません。原本は保持しています。'); };
  for (const [key, value] of Object.entries(entry.localSettings)) if (!key.startsWith('quizMake:sync:') && !key.startsWith('quizMake:coord:') && !key.startsWith('quizMake:notes:')) project(key, value);
  for (const row of preview.records) if (row.collection === 'localStorage') project(row.id, row.raw);
  for (const row of preview.records) if (row.collection === 'questionImages') project('quizMake:image:' + row.id, row.raw);
  project(CATEGORY_NOTES_MANIFEST_KEY, JSON.stringify({ version: 1, keys: preview.records.filter(row => row.collection === 'indexedDbNotes' && row.raw !== null).map(row => row.id).sort() }));
  const connection = { ...entry.identity, syncId: entry.destination.syncId! }, commitId = crypto.randomUUID();
  project('quizMake:sync:id', connection.syncId);
  project('quizMake:sync:recordV2OptIn', connection.syncId);
  project('quizMake:sync:accountConnection:v1', JSON.stringify({ schema: 1, identity: entry.identity, syncId: connection.syncId, paused: false }));
  project('quiz-make-app-data-v1', JSON.stringify(preview.data));
  project('quiz-make-app-data-v1:expected', entry.createdAt);
  const destinationRows = new Map(entry.destination.records.map(row => [row.key, row]));
  const records: AppRecord[] = preview.records.map(row => ({ key: row.key, collection: row.collection, id: row.id, raw: row.raw, position: row.position, localRevision: 1, serverRevision: destinationRows.get(row.key)?.revision ?? 0 }));
  const outbox: AppOutboxOperation[] = records.filter(row => { const old = destinationRows.get(row.key); return old ? row.raw !== old.raw || row.position !== old.position : row.raw !== null; }).map(row => ({ ...row, operationId: crypto.randomUUID(), baseRevision: row.serverRevision, ...(destinationRows.has(row.key) ? { baseContent: { raw: destinationRows.get(row.key)!.raw, position: destinationRows.get(row.key)!.position } } : {}) }));
  const counts = Object.fromEntries(APP_COLLECTIONS.map(name => [name, records.filter(row => row.collection === name && row.raw !== null).length])) as AppRecordState['counts'];
  const db = await openUnionStage(factory, staged);
  try { deps.assertCurrent(); const tx = db.transaction(['appData', 'appRecords', 'appRecordMeta', 'appOutbox', 'categoryNotes', 'questionImageBlobs'], 'readwrite'), completion = done(tx);
    for (const store of ['appRecords', 'appRecordMeta', 'appOutbox', 'categoryNotes', 'questionImageBlobs']) tx.objectStore(store).clear();
    records.forEach(row => tx.objectStore('appRecords').put(row, row.key)); outbox.forEach(row => tx.objectStore('appOutbox').put(row, row.key));
    records.filter(row => row.collection === 'indexedDbNotes' && row.raw !== null).forEach(row => tx.objectStore('categoryNotes').put(row.raw, row.id));
    images.forEach(image => tx.objectStore('questionImageBlobs').put(image, image.id));
    const meta = tx.objectStore('appRecordMeta'); meta.put({ schema: 1, revision: 1, commitId, savedAt: entry.createdAt, counts } satisfies AppRecordState, 'state');
    meta.put(connection, 'recordSyncConnection'); meta.put({ connection, cursor: entry.destination.head }, 'pullCursor');
    meta.put(1, 'notesMigrationV1'); meta.put(1, 'questionImageMigrationV1'); meta.put(1, 'recordMediaPresent'); meta.put(entry.id, 'unionMigration');
    tx.objectStore('appData').put(1, 'quiz-make-app-data-v1:record-schema'); await completion; deps.assertCurrent();
  } finally { db.close(); }
  const prepared = { ...entry, revision: entry.revision + 1, phase: 'prepared' as const, preparedCommitId: commitId, preparedFingerprint: await contentFingerprint(entry, preview.records) };
  await saveJournal(factory, prepared, deps.assertCurrent); return prepared;
}
export async function activateUnionMigration(factory: IDBFactory, native: Storage, entry: UnionJournal, deps: Pick<UnionPreparation, 'assertCurrent' | 'readLocal' | 'recheckCloud'>) {
  deps.assertCurrent(); validateJournal(entry); if (entry.phase !== 'prepared') throw new Error('統合先の準備が完了していません。');
  await assertSavedJournal(factory, native, entry, deps.assertCurrent);
  if (readAccountGeneration(native, entry.identity) !== entry.previousGeneration || await unionFingerprint(await deps.readLocal()) !== entry.localFingerprint) throw new Error('準備後に端末データが変わりました。原本を保持して確認を止めました。');
  for (const snapshot of [entry.destination, ...entry.sources]) if (snapshot.kind === 'cloud') { await deps.recheckCloud(snapshot); deps.assertCurrent(); }
  const staged = new AccountStorageSession(native, { identity: entry.identity, namespace: accountNamespace(entry.identity), legacyUnclaimed: false }, { generation: entry.generation, staging: true }), db = await openUnionStage(factory, staged);
  try { const tx = db.transaction('appRecordMeta'), completion = done(tx); const state = tx.objectStore('appRecordMeta').get('state'); await completion; if (state.result?.commitId !== entry.preparedCommitId) throw new Error('準備中の内容が変わりました。原本は保持しています。'); } finally { db.close(); }
  await assertSavedJournal(factory, native, entry, deps.assertCurrent);
  deps.assertCurrent(); const pointer = accountGenerationKey(entry.identity); native.setItem(pointer, entry.generation);
  if (native.getItem(pointer) !== entry.generation) throw new Error('統合後の保存先を記録できません。原本は保持しています。');
  // A crash here is recovered from pointer === generation, even if this receipt
  // fails. The pointer is the only activation commit; no source store was edited.
  try { await saveJournal(factory, { ...entry, revision: entry.revision + 1, phase: 'activated' }, () => {}); } catch { /* Recovery infers activation from the verified pointer. */ }
}
export async function rollbackUnionMigration(factory: IDBFactory, native: Storage, entry: UnionJournal, assertCurrent: () => void) {
  assertCurrent(); validateJournal(entry); if (readAccountGeneration(native, entry.identity) !== entry.generation) throw new Error('この統合先は利用中ではありません。');
  await assertSavedJournal(factory, native, entry, assertCurrent);
  const active = new AccountStorageSession(native, { identity: entry.identity, namespace: accountNamespace(entry.identity), legacyUnclaimed: false }), db = await openUnionStage(factory, active);
  try { const tx = db.transaction(['appRecordMeta', 'appRecords']), completion = done(tx); const rows = tx.objectStore('appRecords').getAll(), batch = tx.objectStore('appRecordMeta').get('pushBatch'), stage = tx.objectStore('appRecordMeta').get('pullStage'); await completion;
    const snapshot: UnionSnapshot = { ...entry.destination, kind: 'local', records: (rows.result as AppRecord[]).map(row => ({ key: row.key, collection: row.collection, id: row.id, raw: row.logicalRaw ?? row.raw, position: row.position, revision: entry.destination.records.find(old => old.key === row.key)?.revision ?? 0 })) };
    if (batch.result || stage.result || await contentFingerprint(entry, snapshot.records) !== entry.preparedFingerprint) throw new Error('統合後の学習・変更・未確認送信があります。新しいデータを保持するため、巻き戻しを止めました。');
  } finally { db.close(); }
  await assertSavedJournal(factory, native, entry, assertCurrent);
  assertCurrent(); const pointer = accountGenerationKey(entry.identity); if (entry.previousGeneration === null) native.removeItem(pointer); else native.setItem(pointer, entry.previousGeneration);
  if (native.getItem(pointer) !== entry.previousGeneration) throw new Error('元の保存先へ戻せませんでした。両方の原本は保持しています。');
  await saveJournal(factory, { ...entry, revision: entry.revision + 1, phase: 'rolled_back' }, () => {});
}
