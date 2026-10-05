import { AccountStorageSession, ACCOUNT_VAULT_MANIFEST_KEY, getAccountStorageSession, sameLocalAccount, type LocalAccountIdentity } from './accountStorage';
import { APP_COLLECTIONS, appRecordKey, readAppRecordSnapshot, type AppRecord } from './appRecordStorage';
import { validateUnionSnapshot, type UnionRecord, type UnionSnapshot } from './accountUnionPlan';
import { isChunkInternal, parseChunkManifest, restoreRecordChunks, RECORD_CHUNK_GUARD_ID, RECORD_CHUNK_GUARD_RAW } from './recordChunkFormat';
import { validateRecordPullPage } from './recordSyncPull';
import { parseAccountResolverResult } from './accountSync';
import { normalizeAppData } from './appDataValidation';
import { readStoredAccountBinding } from './accountStorageBootstrap';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { createQuestionImageTransport, storedQuestionImage, verifyQuestionImageBlob } from './questionImageCloud';
import { describeQuestionImage, type StoredQuestionImage } from './questionImageRecords';
import type { RecordPushAcknowledgement } from './recordSyncOutbox';
import { CATEGORY_NOTES_RECOVERY_REQUIRED_KEY } from './noteStorage';

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('原本を読み取れません。')); });
export async function openUnionOriginal(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => { const r = factory.open(name); let absent = false, failed = false;
    r.onupgradeneeded = () => { absent = true; r.transaction?.abort(); }; r.onerror = () => absent ? resolve(null) : reject(r.error);
    r.onblocked = () => { failed = true; reject(new Error('原本を開けません。ほかのQuizMake画面を閉じてください。')); };
    r.onsuccess = () => { if (failed) r.result.close(); else resolve(r.result); }; });
}
export type UnionCloudReader = { identity: LocalAccountIdentity; assertCurrent(): void; resolveOwned(id: string): Promise<unknown>; meta(id: string): Promise<{ updatedAt: string }>; open(id: string, stamp: string): Promise<number>; pull(id: string, cursor: number): Promise<unknown> };
export async function decodeUnionRecords(records: UnionRecord[]) {
  const parts = new Map(records.filter(row => row.collection === 'localStorage' && row.raw !== null).map(row => [row.id, row.raw!]));
  const result: UnionRecord[] = [];
  for (const row of records) {
    if (isChunkInternal(row.collection, row.id)) continue;
    const manifest = parseChunkManifest(row.raw, row.collection, row.id);
    if (manifest && parts.get(RECORD_CHUNK_GUARD_ID) !== RECORD_CHUNK_GUARD_RAW) throw new Error('分割された原本が揃っていません。');
    result.push(manifest ? { ...row, raw: await restoreRecordChunks(manifest, parts) } : row);
  }
  return result;
}
/** An ID is never ownership evidence. The resolver checks an already owned row
 * before any meta/open/read RPC (those legacy RPCs can otherwise claim null owners). */
export async function readOwnedUnionCloud(reader: UnionCloudReader, id: string, label: string): Promise<UnionSnapshot> {
  reader.assertCurrent(); if (!/^[a-f0-9]{36}$/u.test(id)) throw new Error('確認済みの保存先を選んでください。');
  const ownership = parseAccountResolverResult(await reader.resolveOwned(id)); reader.assertCurrent();
  if (!['ok', 'migration_required'].includes(ownership.code)) throw new Error('このアカウントが所有する保存先と確認できません。読み込みを止めました。');
  if (ownership.code === 'ok' && ownership.syncId !== id) throw new Error('所有権確認と保存先が一致しません。読み込みを止めました。');
  const meta = await reader.meta(id); reader.assertCurrent(); const opened = await reader.open(id, meta.updatedAt); reader.assertCurrent();
  const records = new Map<string, UnionRecord>(); let cursor = 0, head = opened;
  for (let pages = 0; pages < 10000; pages++) {
    const page = validateRecordPullPage(await reader.pull(id, cursor), cursor); reader.assertCurrent(); if(page.head<opened)throw new Error('保存先の履歴が巻き戻っています。読み込みを止めました。');head = page.head;
    for (const batch of page.batches) for (const row of batch.changes) {
      const old = records.get(row.key); records.set(row.key, { ...row, ...(row.raw === null && (old?.raw ?? old?.previousRaw) ? { previousRaw: (old?.raw ?? old?.previousRaw)! } : {}) });
    }
    cursor = page.cursor;
    if (!page.hasMore) {
      const snapshot: UnionSnapshot = { identity: reader.identity, label, kind: 'cloud', syncId: id, head, records: await decodeUnionRecords([...records.values()]) };
      validateUnionSnapshot(snapshot, reader.identity); return snapshot;
    }
  }
  throw new Error('統合元の読み込みが上限に達しました。原本は保持しています。');
}
export async function createUnionCloudReader(): Promise<UnionCloudReader> {
  const { getCloudAccessToken, getCachedCloudAccountIdentity } = await import('./cloudService');
  const { getRemoteSyncConfig } = await import('./syncService');
  const owner = getAccountStorageSession(), identity = owner?.identity, config = getRemoteSyncConfig();
  if (!owner || !identity || !config || config.url !== identity.project) throw new Error('所有アカウントと接続先を確認できません。');
  const assertCurrent = () => { owner.assertNetworkCurrent(identity); if (!sameLocalAccount(identity, getCachedCloudAccountIdentity()) || getRemoteSyncConfig()?.url !== config.url) throw new Error('アカウントまたは接続先が変わりました。原本は保持しています。'); };
  const rpc = async (name: string, args: object) => { assertCurrent(); const access = await getCloudAccessToken(); assertCurrent();
    if (!access.ok || access.userId !== identity.userId) throw new Error(access.ok ? 'アカウントが変わりました。' : access.message);
    const response = await fetch(config.url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: config.anonKey, Authorization: 'Bearer ' + access.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(30000), redirect: 'error' });
    assertCurrent(); if (!response.ok) throw new Error(`保存先の確認を完了できません（HTTP ${response.status}）。原本は保持しています。`); return response.json(); };
  return { identity, assertCurrent, resolveOwned: id => rpc('quiz_sync_resolve_account', { p_existing_sync_id: id }),
    async meta(id) { const rows = await rpc('quiz_sync_meta', { p_sync_id: id }); if (!Array.isArray(rows) || rows.length !== 1 || rows[0].sync_id !== id || !Number.isFinite(Date.parse(rows[0].updated_at))) throw new Error('所有する保存先の更新情報を確認できません。'); return { updatedAt: rows[0].updated_at }; },
    async open(id, stamp) { const row = await rpc('quiz_sync_v2_open', { p_sync_id: id, p_expected_updated_at: stamp }); if (row?.code !== 'ok' || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('保存先が更新されたか、差分形式を確認できません。原本は保持しています。'); return row.revision; },
    pull: (id, cursor) => rpc('quiz_sync_v2_pull', { p_sync_id: id, p_cursor: cursor, p_limit: 20 }) };
}
export async function readActiveUnionLocal(assertCurrent: () => void): Promise<UnionSnapshot> {
  const { openCoLocatedNoteDb } = await import('./noteRecordMigration');
  const { openQuestionImageRecordDb } = await import('./questionImageRecords');
  const { captureSyncedLocalStorage, replayLocalStorageProjections } = await import('./localStorageRecords');
  const { isQuizMakeStorageKey, waitForLocalPersistence } = await import('./syncService');
  const { APP_DATA_RECOVERY_REQUIRED_KEY } = await import('../storage');
  const { CATEGORY_NOTES_RECOVERY_REQUIRED_KEY } = await import('./noteStorage');
  assertCurrent(); const owner = getAccountStorageSession(); if (!owner?.identity || owner.storage.getItem(APP_DATA_RECOVERY_REQUIRED_KEY) !== null || owner.storage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY) !== null) throw new Error('端末データの復旧確認が必要です。原本は保持しています。');
  const saved = await waitForLocalPersistence(); if (!saved.ok) throw new Error(saved.error);
  await openCoLocatedNoteDb(); await replayLocalStorageProjections(); await captureSyncedLocalStorage(isQuizMakeStorageKey);
  const db = await openQuestionImageRecordDb(), snapshot = await readAppRecordSnapshot(db); assertCurrent();
  if (!snapshot) throw new Error('端末の原本を確認できません。');
  const tx = db.transaction(['appRecordMeta', 'appRecordBackups']), completion = done(tx), batch = tx.objectStore('appRecordMeta').get('pushBatch'), old = tx.objectStore('appRecordBackups').getAll(); await completion;
  if (batch.result) throw new Error('元の保存先への送信結果が未確認です。送信結果を確認してから統合してください。元の送信原本は保持しています。');
  const backup = new Map((old.result as AppRecord[]).map(row => [row.key, row.raw]));
  const records = await decodeUnionRecords([...snapshot.records.values()].map(row => ({ key: row.key, collection: row.collection, id: row.id, raw: row.logicalRaw ?? row.raw, position: row.position, revision: row.serverRevision, ...(row.raw === null && backup.get(row.key) ? { previousRaw: backup.get(row.key)! } : {}) })));
  const result: UnionSnapshot = { identity: owner.identity, label: 'この端末', kind: 'local', head: Math.max(0, ...records.map(row => row.revision)), records };
  validateUnionSnapshot(result, owner.identity); return result;
}
export function archivedLegacyOwnedBy(native: Storage, identity: LocalAccountIdentity): boolean {
  const raw = native.getItem(ACCOUNT_VAULT_MANIFEST_KEY); if (!raw) return false; const row = JSON.parse(raw);
  return row.version === 1 && row.archived === true && sameLocalAccount(row.legacyOwner, identity);
}
export async function readArchivedUnionLocal(factory: IDBFactory, native: Storage, identity: LocalAccountIdentity, assertCurrent: () => void, storageKeyFilter?: (key: string) => boolean): Promise<UnionSnapshot> {
  assertCurrent(); if (!archivedLegacyOwnedBy(native, identity)) throw new Error('このアカウントの保管済み端末データではありません。');
  if (native.getItem('quiz-make-app-data-v1:recovery-required') !== null || native.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY) !== null) throw new Error('保管した端末データの復旧確認が必要です。原本と控えを保持して統合を止めました。');
  const binding = await readStoredAccountBinding(factory, 'quiz-make-app-data-v1'); assertCurrent(); if (binding && !sameLocalAccount(binding, identity)) throw new Error('旧端末データは別のアカウントに所属しています。');
  const isQuizMakeStorageKey = storageKeyFilter ?? (await import('./syncService')).isQuizMakeStorageKey;
  const db = await openUnionOriginal(factory, 'quiz-make-app-data-v1'); let records: UnionRecord[] = [], notesMigrated = false, imagesMigrated = false;
  const { readLearningValues } = await import('./learningValueStorage');
  let learning = new Map<string, import('./learningValueStorage').LearningValue>();
  try {
    if (db?.objectStoreNames.contains('appData')) learning = await readLearningValues(db);
    if (db?.objectStoreNames.contains('appRecordMeta')) {
      const tx = db.transaction('appRecordMeta'), completion = done(tx), store = tx.objectStore('appRecordMeta');
      const notes = store.get('notesMigrationV1'), images = store.get('questionImageMigrationV1'), batch = store.get('pushBatch'); await completion;
      if (batch.result) throw new Error('保管した端末領域に送信結果の確認が必要な原本があります。元の接続で確認してから統合してください。保管した原本は保持しています。');
      notesMigrated = notes.result === 1; imagesMigrated = images.result === 1;
    }
    const snapshot = db?.objectStoreNames.contains('appRecordMeta') && db.objectStoreNames.contains('appData') ? await readAppRecordSnapshot(db) : null;
    if (snapshot) records = [...snapshot.records.values()].map(row => ({ ...row, raw: row.logicalRaw ?? row.raw, revision: row.serverRevision }));
    else {
      const candidates = [native.getItem('quiz-make-app-data-v1')];
      const fallback = native.getItem('quiz-make-app-data-v1:fallback-record');
      if (fallback) { const value = JSON.parse(fallback); if (typeof value.raw !== 'string') throw new Error('旧端末の控えを確認できません。'); candidates.push(value.raw); }
      if (db?.objectStoreNames.contains('appData')) { const tx = db.transaction('appData'), completion = done(tx), raw = tx.objectStore('appData').get('quiz-make-app-data-v1'); await completion; if (raw.result !== undefined && typeof raw.result !== 'string') throw new Error('旧端末の保存本体を確認できません。'); candidates.push(raw.result ?? null); }
      const originals = [...new Set(candidates.filter((raw): raw is string => raw !== null))];
      if (!originals.length) throw new Error('旧端末の教材原本を読み取れません。保存済みの領域は保持しています。');
      const parsed = originals.map(raw => { const value = JSON.parse(raw), result = normalizeAppData(value); if (!result.ok) throw new Error(result.error);
        const logs = Array.isArray(value.answerLogs) ? value.answerLogs : [], progress = Array.isArray(value.progress) ? value.progress : [];
        if (new Set(logs.map((row: { id?: string }) => row?.id)).size !== result.data.answerLogs.length || progress.some((row: { questionId?: string }) => !result.data.questions.some(q => q.id === row?.questionId)) || new Set(progress.map((row: { questionId?: string }) => row?.questionId)).size !== progress.length) throw new Error('旧端末の回答履歴または学習状態を欠落させずに読み取れません。原本を保持して確認を止めました。');
        return result.data; });
      if (parsed.some(value => JSON.stringify(value) !== JSON.stringify(parsed[0]))) throw new Error('旧端末の保存本体と控えが異なります。両方の原本を保管して確認を止めました。');
      const normalized = { data: parsed[0] };
      records = APP_COLLECTIONS.flatMap(collection => normalized.data[collection].map((value, position) => { const id = collection === 'progress' ? (value as { questionId: string }).questionId : (value as { id: string }).id; return { key: appRecordKey(collection, id), collection, id, raw: JSON.stringify(value), position, revision: 0 }; }));
    }
  } finally { db?.close(); }
  const known = new Map(records.map(row => [row.key, row]));
  for (const [id, value] of learning) {
    const key = appRecordKey('localStorage', id), old = known.get(key);
    // Record pull may have committed after its previous materialized view. The
    // canonical record remains authoritative; a view-only legacy value is kept.
    if (!old) known.set(key, { key, collection: 'localStorage', id, raw: value.raw, position: 0, revision: 0 });
  }
  for (let i = 0; i < native.length; i++) {
    const id = native.key(i); if (!id || !isQuizMakeStorageKey(id) || id === 'quiz-make-app-data-v1' || isChunkInternal('localStorage', id)) continue;
    const raw = native.getItem(id); if (raw === null) continue;
    if (id.startsWith('quizMake:image:')) continue; // Blob-derived descriptors are authoritative, never a metadata-only copy.
    const collection = id.startsWith('quizMake:notes:') ? 'indexedDbNotes' : 'localStorage', key = appRecordKey(collection, id), old = known.get(key);
    if (notesMigrated && collection === 'indexedDbNotes') continue;
    if (old && old.raw !== raw) {
      const cleanup = learning.get(id)?.nativeCleanup;
      const digest = cleanup && [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (cleanup === digest) continue;
      throw new Error('旧端末の保存本体と控えが異なります。原本を保管して確認を止めました。');
    }
    known.set(key, { key, collection, id, raw, position: 0, revision: old?.revision ?? 0 });
  }
  const noteDb = notesMigrated ? null : await openUnionOriginal(factory, 'quiz-make-notes-v1');
  try { if (noteDb?.objectStoreNames.contains('categoryNotes')) {
    const tx = noteDb.transaction('categoryNotes'), completion = done(tx), keys = tx.objectStore('categoryNotes').getAllKeys(), values = tx.objectStore('categoryNotes').getAll(); await completion;
    keys.result.forEach((id, i) => { if (typeof id !== 'string' || typeof values.result[i] !== 'string') throw new Error('旧ノート原本の形式を確認できません。'); const key = appRecordKey('indexedDbNotes', id), old = known.get(key), raw = values.result[i]; if (old && old.raw !== raw) throw new Error('旧ノートと控えが異なります。両方の原本は保持しています。'); known.set(key, { key, collection: 'indexedDbNotes', id, raw, position: 0, revision: old?.revision ?? 0 }); });
  } } finally { noteDb?.close(); }
  if (!imagesMigrated) {
    const imageDb = await openUnionOriginal(factory, 'quiz-make-local-question-images-v1');
    try { if (imageDb?.objectStoreNames.contains('images')) {
      const tx = imageDb.transaction('images'), completion = done(tx), values = tx.objectStore('images').getAll(); await completion;
      for (const image of values.result as StoredQuestionImage[]) { const descriptor = await describeQuestionImage(image); assertCurrent(); const key = appRecordKey('questionImages', image.id), old = known.get(key);
        if (old?.raw !== undefined && (old.raw === null || !await verifyQuestionImageBlob(image.blob, parseQuestionImageDescriptor(old.raw)))) throw new Error('旧画像と保存本体が異なります。両方の原本は保持しています。');
        if (!old) known.set(key, { key, collection: 'questionImages', id: image.id, raw: JSON.stringify(descriptor), position: 0, revision: 0 });
      }
    } } finally { imageDb?.close(); }
  }
  const result: UnionSnapshot = { identity, label: '保管した端末データ', kind: 'local', head: Math.max(0, ...[...known.values()].map(row => row.revision)), records: await decodeUnionRecords([...known.values()]) };
  assertCurrent(); validateUnionSnapshot(result, identity); return result;
}
export async function readUnionImage(row: UnionRecord, assertCurrent: () => void): Promise<StoredQuestionImage> {
  const descriptor = parseQuestionImageDescriptor(row.raw!); assertCurrent(); const owner = getAccountStorageSession(); if (!owner?.identity) throw new Error('画像の所有者を確認できません。');
  const names = [owner.databaseName('quiz-make-app-data-v1'), owner.databaseName('quiz-make-local-question-images-v1')];
  if (archivedLegacyOwnedBy(globalThis.localStorage, owner.identity)) names.push('quiz-make-app-data-v1', 'quiz-make-local-question-images-v1');
  for (const name of names) {
    const db = await openUnionOriginal(indexedDB, name); try { const store = db?.objectStoreNames.contains('questionImageBlobs') ? 'questionImageBlobs' : db?.objectStoreNames.contains('images') ? 'images' : null;
      if (db && store) { const tx = db.transaction(store), completion = done(tx), image = tx.objectStore(store).get(descriptor.id); await completion; assertCurrent(); if (image.result?.blob && await verifyQuestionImageBlob(image.result.blob, descriptor)) return storedQuestionImage(descriptor, image.result.blob); }
    } finally { db?.close(); }
  }
  const { getCloudAccessToken } = await import('./cloudService'), { getRemoteSyncConfig } = await import('./syncService');
  const access = await getCloudAccessToken(), config = getRemoteSyncConfig(); assertCurrent(); if (!access.ok || !config || access.userId !== owner.identity.userId) throw new Error('画像の取得用アカウントを確認できません。');
  const blob = await createQuestionImageTransport(config, access).download(descriptor); assertCurrent(); return storedQuestionImage(descriptor, blob);
}

/** Explicitly settle only the captured frozen request at its original, freshly
 * verified owner stream. Never transfer uncertain operation IDs to a new stream. */
export async function settleUnionSourceSend() {
  const { getCloudAccessToken } = await import('./cloudService'), { getRemoteSyncConfig, getStoredSyncId } = await import('./syncService');
  const { getPendingRecordPushBatch, acknowledgeRecordPushBatch, releaseRejectedRecordPushBatch } = await import('./recordSyncOutbox');
  const { createRecordSyncRpc } = await import('./recordSyncNetwork');
  const owner = getAccountStorageSession(), config = getRemoteSyncConfig(), reader = await createUnionCloudReader();
  if (!owner?.identity || !config) throw new Error('元の送信先の所有者を確認できません。');
  const binding = await readStoredAccountBinding(indexedDB, owner.databaseName('quiz-make-app-data-v1')); reader.assertCurrent();
  if (!binding || !sameLocalAccount(binding, owner.identity) || getStoredSyncId() !== binding.syncId) throw new Error('元の送信先が変わりました。送信原本は保持しています。');
  const proof = parseAccountResolverResult(await reader.resolveOwned(binding.syncId)); reader.assertCurrent();
  if (!['ok', 'migration_required'].includes(proof.code) || proof.code === 'ok' && proof.syncId !== binding.syncId) throw new Error('元の送信先の所有権を確認できません。再送を止めました。');
  const db = await openUnionOriginal(indexedDB, owner.databaseName('quiz-make-app-data-v1')); if (!db) throw new Error('元の送信原本を読み取れません。');
  try {
    const batch = await getPendingRecordPushBatch(db, binding); if (!batch) return;
    const assertCurrent = () => { reader.assertCurrent(); if (getStoredSyncId() !== binding.syncId) throw new Error('元の送信先が変わりました。'); };
    const rpc = createRecordSyncRpc({ ...config, connection: binding, assertCurrent, async access() { const access = await getCloudAccessToken(); assertCurrent(); if (!access.ok) throw new Error(access.message); return access; } });
    const value = await rpc.push(batch.operations); assertCurrent();
    if (!value || typeof value !== 'object' || !('code' in value)) throw new Error('元の送信結果を確認できません。送信原本は保持しています。');
    if (value.code === 'conflict') await releaseRejectedRecordPushBatch(db, batch);
    else if (value.code === 'ok') await acknowledgeRecordPushBatch(db, batch, value as RecordPushAcknowledgement);
    else throw new Error('元の送信結果を確認できません。送信原本は保持しています。');
  } finally { db.close(); }
}
