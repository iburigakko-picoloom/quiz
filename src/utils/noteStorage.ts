import { SyncDataError } from './syncDataIntegrity';
import { accountLocalStorage as localStorage, getAccountStorageSession } from './accountStorage';
import { advanceLocalDataRevision } from './localDataRevision';
import { validMaterialRecord } from './materialModel';
import { loadLatestCoordinatedData, withCoordinatedDataMutation } from './dataCoordination';
import { hasPersistedSyncHistory } from './syncState';

import { openCoLocatedNoteDb } from './noteRecordMigration';
import { NOTE_RECORD_TRANSACTION_STORES, queueNoteRecordWrite, abortPendingNoteTransactions } from './auxiliaryRecordStorage';
import { cleanupNativeOriginals } from './learningValueStorage';
import { reconstructCanonicalNote } from './noteRecovery';
import { packBlobNote, parseBlobNote, readMeta, unpackBlobNote, queueBlobReferences } from './blobVault';
import { openAppDb } from '../storage';
const downloadContentBlob = async (ref: import('./blobVault').BlobRef) => (await import('./blobCloud')).downloadContentBlob(ref);
const NOTE_STORE_NAME = 'categoryNotes';
const NOTE_BACKUP_STORE_NAME = 'categoryNoteBackups';
const NOTE_STORAGE_OPERATION_TIMEOUT_MS = 4_500;
export const CATEGORY_NOTE_KEY_PREFIX = 'quizMake:notes:';
export const CATEGORY_NOTES_MANIFEST_KEY = 'quiz-make-note-storage-v1:manifest';
export const CATEGORY_NOTES_RECOVERY_REQUIRED_KEY = 'quiz-make-note-storage-v1:recovery-required';
export function getNoteBackupIssues(notes: Record<string,string>): string[] {
  const manifest=readCategoryNotesManifest(),issues:string[]=[];
  if(manifest.kind==='invalid' || manifest.kind==='missing' && hasPersistedSyncHistory())issues.push('ノートの保存一覧を確認できません。');
  if(manifest.kind==='valid')for(const key of manifest.keys)if(notes[key]===undefined)issues.push(`ノート未収録: ${key}`);
  if(isCategoryNotesRecoveryRequired())issues.push('ノートの復旧確認が必要です。');
  return issues;
}

export class CategoryNoteStorageTimeoutError extends Error {
  constructor() {
    super('Category note storage operation timed out.');
    this.name = 'CategoryNoteStorageTimeoutError';
  }
}

export class CategoryNoteRecoveryRequiredError extends Error {
  readonly key:string;
  readonly candidate:string|null;
  constructor(key:string,candidate:string|null){
    super('このノートの正規の版を確認できません。復旧候補を確認し、復元する内容を選んでください。');
    this.name='CategoryNoteRecoveryRequiredError';
    this.key=key;this.candidate=candidate;
  }
}

let persistenceRequested = false;
let noteSaveQueue: Promise<unknown> = Promise.resolve();

export function isCategoryNoteKey(key: string): boolean {
  return key.startsWith(CATEGORY_NOTE_KEY_PREFIX);
}

export function isCategoryNoteKeyForProblemSetIds(key: string, problemSetIds: Iterable<string>): boolean {
  if (!isCategoryNoteKey(key)) return false;
  for (const problemSetId of problemSetIds) {
    if (typeof problemSetId !== 'string' || problemSetId.length === 0) continue;
    if (key.startsWith(`${CATEGORY_NOTE_KEY_PREFIX}${problemSetId}:`)) return true;
  }
  return false;
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function loadCategoryNoteRaw(key: string, options: { coordinationLockHeld?: boolean } = {}): Promise<string | null> {
  if (!isCategoryNoteKey(key)) return null;
  const hydrate = async (raw: string | null) => raw && parseBlobNote(raw) ? unpackBlobNote(await openAppDb(), raw, downloadContentBlob) : raw;
  if (options.coordinationLockHeld) return hydrate(await loadCategoryNoteRawUnlocked(key));
  await waitForPendingCategoryNoteSaves();
  return hydrate(await loadLatestCoordinatedData(['notes'], () => loadCategoryNoteRawUnlocked(key)));
}

async function loadCategoryNoteRawUnlocked(key: string): Promise<string | null> {
  let indexedCurrent: string | null = null;
  let indexedBackup: string | null = null;
  let indexedCurrentError: unknown = null;
  let indexedBackupError: unknown = null;
  if (isIndexedDbAvailable()) {
    try { indexedCurrent = await waitForCategoryNoteStorage(getRawFromIndexedDb(key)); }
    catch (error) {
      indexedCurrentError = error;
      console.warn('Failed to read the current category note from IndexedDB.', error);
      if (error instanceof CategoryNoteStorageTimeoutError) abandonNoteDbConnection();
    }
  }

  const legacyRead = readLocalStorageValue(key);
  const legacy = legacyRead.value;
  const hasValidCurrent = indexedCurrent !== null && isUsableNoteRaw(indexedCurrent);
  const hasValidLegacy = legacy !== null && isUsableNoteRaw(legacy);

  // A legacy value is the durable fallback written when IndexedDB could not be
  // updated. It remains safe to load even while IndexedDB is temporarily down.
  // Without that fallback, a failed current-store read must never be mistaken
  // for a genuinely empty note: editing an empty canvas could overwrite data
  // that still exists in the unreadable store.
  if (indexedCurrentError && !hasValidLegacy) {
    throw createCategoryNoteReadError(indexedCurrentError);
  }
  if (legacyRead.error && !hasValidCurrent) {
    throw createCategoryNoteReadError(legacyRead.error);
  }
  // Healthy current/legacy originals already determine the result. Avoid
  // cloning a second full PNG/PDF and waiting for its recovery-store read on
  // every page turn. Recovery still runs when neither original is usable.
  // The usual single-original case also needs only one validation/JSON parse.
  if (hasValidCurrent && hasValidLegacy) return pickNewestNoteRaw([indexedCurrent, legacy]);
  if (hasValidCurrent) return indexedCurrent;
  if (isIndexedDbAvailable()) {
    const canonical=await waitForCategoryNoteStorage(reconstructCanonicalNote(key,isUsableNoteRaw));
    if(canonical!==undefined){
      clearCategoryNoteRecovery(key);
      // A durable local fallback can be a newer unsent edit, but a canonical
      // deletion must never resurrect it merely by opening the drawer.
      if(canonical===null)return null;
      return hasValidLegacy?pickNewestNoteRaw([canonical,legacy]):canonical;
    }
  }
  if (hasValidLegacy) return legacy;
  if (isIndexedDbAvailable()) {
    try { indexedBackup = await waitForCategoryNoteStorage(getBackupRawFromIndexedDb(key)); }
    catch (error) {
      indexedBackupError = error;
      console.warn('Failed to read the category note backup from IndexedDB.', error);
      if (error instanceof CategoryNoteStorageTimeoutError) abandonNoteDbConnection();
    }
  }
  if (indexedBackup !== null && (await readDeletedNoteKeys([key])).has(key)) return null;
  const preferred = pickNewestNoteRaw([indexedBackup]);
  if (indexedBackupError && preferred === null) {
    throw createCategoryNoteReadError(indexedBackupError);
  }
  if (preferred === null) {
    if (indexedCurrent !== null || indexedBackup !== null || legacy !== null) {
      throw createCategoryNoteReadError(new Error('Stored category note data is invalid.'));
    }
    const manifest = readCategoryNotesManifest();
    if (manifest.kind === 'valid' && manifest.keys.includes(key)) {
      markCategoryNotesRecoveryRequiredBestEffort('missing-current',key);
      throw new CategoryNoteRecoveryRequiredError(key,null);
    }
    return null;
  }

  if (!hasValidCurrent && !hasValidLegacy && indexedBackup !== null) {
    markCategoryNotesRecoveryRequiredBestEffort('backup-only',key);
    throw new CategoryNoteRecoveryRequiredError(key,preferred);
  }

  return preferred;
}
export async function requestPersistentStorage(): Promise<boolean> {
  if (persistenceRequested || typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  persistenceRequested = true;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function saveCategoryNoteRaw(key: string, raw: string): Promise<void> {
  return enqueueCategoryNoteOperation(() => saveCategoryNoteRawNow(key, raw));
}

export async function waitForPendingCategoryNoteSaves(): Promise<void> {
  await noteSaveQueue;
}

/** Update the material list and remove its file/ink in one durable transaction. */
export async function replaceNoteAndDeleteKeys(key: string, raw: string, keys: readonly string[]): Promise<void> {
  if (!isCategoryNoteKey(key) || !isUsableNoteRaw(raw) || keys.includes(key) || keys.some(id => !isCategoryNoteKey(id))) throw new Error('削除する資料情報が不正です。');
  // Caller holds the shared app/notes lock and has checked current references.
  const db = await openNoteDb(true);
  const deleted = new Set(keys);
  const previous = collectLegacyLocalStorageNotesOrThrow(id => id === key || deleted.has(id));
  removeLegacyLocalStorageNotesOrThrow(previous);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(NOTE_RECORD_TRANSACTION_STORES, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('資料を削除できませんでした。'));
      tx.objectStore(NOTE_STORE_NAME).put(raw, key);
      queueNoteRecordWrite(tx, key, raw);
      for (const id of deleted) {
        tx.objectStore(NOTE_STORE_NAME).delete(id);
        tx.objectStore(NOTE_BACKUP_STORE_NAME).delete(id);
        queueNoteRecordWrite(tx, id, null);
        queueBlobReferences(tx, `note-backup:${JSON.stringify(['indexedDbNotes', id])}`, null);
        tx.objectStore('appRecordMeta').delete(`materialOffline:${id}`);
        tx.objectStore('appRecordMeta').delete(`materialCache:${id}`);
      }
    });
  } catch (error) {
    restoreLegacyLocalStorageNotes(previous);
    throw error;
  }
  await recordCategoryNoteDeletionBestEffort(id => deleted.has(id));
  await ensureCategoryNoteManifestIncludesBestEffort(key);
  advanceLocalDataRevision();
}

export async function deleteCategoryNotesForProblemSetIds(
  problemSetIds: Iterable<string>,
  options: { coordinationLockHeld?: boolean } = {},
): Promise<number> {
  const ids = new Set(Array.from(problemSetIds).filter((id) => typeof id === 'string' && id.length > 0));
  if (ids.size === 0) return 0;
  return enqueueCategoryNoteOperation(async () => {
    const predicate = (key: string) => isCategoryNoteKeyForProblemSetIds(key, ids);
    const deleted = await deleteCategoryNotesWhere(predicate);
    await recordCategoryNoteDeletionBestEffort(predicate);
    return deleted;
  }, options);
}

export async function deleteAllCategoryNotes(
  options: { coordinationLockHeld?: boolean } = {},
): Promise<number> {
  return enqueueCategoryNoteOperation(async () => {
    const deleted = await deleteCategoryNotesWhere(isCategoryNoteKey);
    if (writeCategoryNotesManifestBestEffort([])) {
      safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
    }
    return deleted;
  }, options);
}

function enqueueCategoryNoteOperation<T>(
  operation: () => Promise<T>,
  options: { coordinationLockHeld?: boolean } = {},
): Promise<T> {
  if (options.coordinationLockHeld) {
    return operation().then((result) => {
      advanceLocalDataRevision();
      return result;
    });
  }
  const queuedOperation = noteSaveQueue
    .catch(() => undefined)
    .then(() => withCoordinatedDataMutation(['notes'], async () => {
        const result = await operation();
        advanceLocalDataRevision();
        return result;
      }));
  noteSaveQueue = queuedOperation;
  return queuedOperation;
}

async function deleteCategoryNotesWhere(predicate: (key: string) => boolean): Promise<number> {
  const localNotes = collectLegacyLocalStorageNotesOrThrow(predicate);
  removeLegacyLocalStorageNotesOrThrow(localNotes);

  try {
    const indexedDbKeys = isIndexedDbAvailable()
      ? await deleteIndexedDbNotesWhere(predicate, localNotes.map(([key]) => key))
      : new Set<string>();
    return new Set([...localNotes.map(([key]) => key), ...indexedDbKeys]).size;
  } catch (error) {
    try {
      restoreLegacyLocalStorageNotes(localNotes);
    } catch (rollbackError) {
      throw new Error(
        `Failed to delete category notes and restore their local fallback copies. `
        + `Delete error: ${getErrorMessage(error)} Restore error: ${getErrorMessage(rollbackError)}`,
      );
    }
    throw error;
  }
}

async function saveCategoryNoteRawNow(key: string, raw: string): Promise<void> {
  if (!isCategoryNoteKey(key)) throw new Error('Invalid category note key.');
  if (!isUsableNoteRaw(raw)) throw new Error('Invalid category note data.');

  void requestPersistentStorage();
  if (isIndexedDbAvailable()) {
    try {
      await waitForCategoryNoteStorage(setRawToIndexedDb(key, raw));
      await cleanupNativeOriginals(await openCoLocatedNoteDb(), { [key]: localStorage.getItem(key) });
      await ensureCategoryNoteManifestIncludesBestEffort(key);
      return;
    } catch (indexedDbError) {
      if (indexedDbError instanceof CategoryNoteStorageTimeoutError) abandonNoteDbConnection();
      try {
        localStorage.setItem(key, raw);
        await ensureCategoryNoteManifestIncludesBestEffort(key);
        return;
      } catch (fallbackError) {
        throw isQuotaExceededError(fallbackError)
          ? new Error('ノート保存容量が足りません。端末の空き容量を増やすか、不要なノートを減らしてください。')
          : indexedDbError;
      }
    }
  }

  try {
    localStorage.setItem(key, raw);
    await ensureCategoryNoteManifestIncludesBestEffort(key);
  } catch (error) {
    throw new Error(isQuotaExceededError(error)
      ? 'ノート保存容量が足りません。端末の空き容量を増やすか、不要なノートを減らしてください。'
      : error instanceof Error
        ? error.message
        : 'ノートの保存に失敗しました。');
  }
}
export async function exportCategoryNotesRaw(
  options: { coordinationLockHeld?: boolean; mode?: 'authoritative' | 'recovery' | 'migration' } = {},
): Promise<Record<string, string>> {
  if (!options.coordinationLockHeld) await waitForPendingCategoryNoteSaves();
  let indexedNotes: Record<string, string> = {};
  let indexedBackups: Record<string, string> = {};

  if (isIndexedDbAvailable()) {
    try {
      indexedNotes = await exportIndexedDbNotes(options.mode === 'recovery'||options.mode === 'migration');
    } catch (error) {
      console.warn('Failed to export category notes from IndexedDB.', error);
      markCategoryNotesRecoveryRequiredBestEffort('read-failure');
      if (options.mode !== 'recovery') {
        throw new Error('端末のノートを読み取れないため、空のバックアップで上書きしないよう作成を中止しました。');
      }
    }
  }

  if (isIndexedDbAvailable()) {
    try {
      indexedBackups = await exportIndexedDbNoteBackups(options.mode === 'recovery'||options.mode === 'migration');
    } catch (error) {
      console.warn('Failed to export category note backups from IndexedDB.', error);
      markCategoryNotesRecoveryRequiredBestEffort('read-failure');
      if (options.mode !== 'recovery') {
        throw new Error('端末のノートバックアップを読み取れないため、欠けた内容で上書きしないよう作成を中止しました。');
      }
    }
  }

  const localFallbackEntries = collectLegacyLocalStorageNotesOrThrow(isCategoryNoteKey);
  const invalidLocalFallback = localFallbackEntries.find(([, raw]) => !isUsableNoteRaw(raw));
  if (invalidLocalFallback) {
    markCategoryNotesRecoveryRequiredBestEffort('invalid-note',invalidLocalFallback[0]);
    if (options.mode !== 'recovery') {
      throw new Error(`端末のノートデータが破損しているため、バックアップを中止しました: ${invalidLocalFallback[0]}`);
    }
  }
  const localFallbacks = Object.fromEntries(localFallbackEntries.filter(([, raw]) => isUsableNoteRaw(raw)));
  const backupOnlyKeys = Object.keys(indexedBackups).filter((key) => (
    indexedNotes[key] === undefined && localFallbacks[key] === undefined
  ));
  const expected=readCategoryNotesManifest();
  const missingKeys=new Set([...backupOnlyKeys,...(expected.kind==='valid'?expected.keys.filter(key=>indexedNotes[key]===undefined&&localFallbacks[key]===undefined):[])]);
  if(isIndexedDbAvailable()&&options.mode!=='migration')for(const key of missingKeys){
    const canonical=await reconstructCanonicalNote(key,isUsableNoteRaw,options.mode!=='recovery');
    if(typeof canonical==='string'){indexedNotes[key]=canonical;clearCategoryNoteRecovery(key);}
    else if(canonical===null)clearCategoryNoteRecovery(key);
  }
  const deletedKeys = await readDeletedNoteKeys([...new Set([...Object.keys(indexedNotes),...backupOnlyKeys,...missingKeys,...Object.keys(localFallbacks)])]);
  const unresolvedKeys = backupOnlyKeys.filter(key => indexedNotes[key]===undefined&&!deletedKeys.has(key));
  const backupOnlyKey = unresolvedKeys[0];
  // Old complete restores left obsolete backups behind. Only an explicit
  // canonical tombstone proves deletion; absence alone never proves it.
  const manifestBefore = readCategoryNotesManifest();
  if (!backupOnlyKey && (deletedKeys.size > 0||missingKeys.size>0) && manifestBefore.kind === 'valid'
      && manifestBefore.keys.every(key => indexedNotes[key] !== undefined || localFallbacks[key] !== undefined || deletedKeys.has(key))) {
    try {
      const marker = JSON.parse(localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY) ?? 'null');
      if (marker?.version === 1 && ['backup-only','missing-current'].includes(marker.reason)) safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
    } catch { /* Unreadable provenance remains protected. */ }
  }
  const authoritativeKeys = new Set([
    ...Object.keys(indexedNotes),
    ...Object.keys(localFallbacks),
    ...(options.mode === 'recovery' ? Object.keys(indexedBackups) : []),
  ]);
  const notes: Record<string, string> = {};
  authoritativeKeys.forEach((key) => {
    if(options.mode!=='recovery'&&deletedKeys.has(key))return;
    const authoritative = pickNewestNoteRaw([
      indexedNotes[key] ?? null,
      localFallbacks[key] ?? null,
    ]);
    const newest = authoritative
      ?? (options.mode === 'recovery' ? pickNewestNoteRaw([indexedBackups[key] ?? null]) : null);
    if (newest !== null) notes[key] = newest;
  });

  if (backupOnlyKey) {
    for(const key of unresolvedKeys)markCategoryNotesRecoveryRequiredBestEffort('backup-only',key);
    if (options.mode !== 'recovery'&&options.mode!=='migration') {
      throw new SyncDataError('note_integrity', '端末のノートが復旧用バックアップにしか残っていないため、古い内容や欠けた内容でクラウドを上書きしないよう保存を中止しました。', { function: 'exportFileBackup', stage: 'local_backup_validate', side: 'local', cause: 'missing' });
    }
  }

  // Legacy migration may carry only current originals into the canonical
  // records/outbox. Recovery candidates stay solely in their backup store.
  if(options.mode==='migration')return sortRecord(notes);

  if (isCategoryNotesRecoveryRequired() && options.mode !== 'recovery') {
    throw new SyncDataError('note_integrity', '端末のノートは復旧確認が必要な状態です。欠けた内容でクラウドを上書きしないよう保存を中止しました。先にクラウドから読み込むか、バックアップを確認してください。', { function: 'exportFileBackup', stage: 'local_backup_validate', side: 'local', cause: 'missing' });
  }

  const manifest = readCategoryNotesManifest();
  if (manifest.kind === 'invalid') {
    markCategoryNotesRecoveryRequiredBestEffort('invalid-manifest');
    if (options.mode !== 'recovery') {
      throw new Error('ノートの保存状態を確認できないため、クラウド保存を中止しました。');
    }
  }
  if (manifest.kind === 'valid') {
    const missingExpectedKey = manifest.keys.find((key) => notes[key] === undefined&&!deletedKeys.has(key));
    if (missingExpectedKey) {
      markCategoryNotesRecoveryRequiredBestEffort('missing-current',missingExpectedKey);
      if (options.mode !== 'recovery') {
        throw new Error('以前保存したノートの一部が端末から消えているため、欠けた内容でクラウドを上書きしないよう保存を中止しました。');
      }
    }
  } else if (manifest.kind === 'missing' && hasPersistedSyncHistory()) {
    markCategoryNotesRecoveryRequiredBestEffort('missing-manifest');
    if (options.mode !== 'recovery') {
      throw new Error('同期済みのノート保存状態をこの端末で確認できないため、欠けた内容でクラウドを上書きしないよう保存を中止しました。一度クラウドから読み込んでください。');
    }
  }

  if (options.mode !== 'recovery') writeCategoryNotesManifest(Object.keys(notes));

  for (const [key, raw] of Object.entries(notes)) if (parseBlobNote(raw)) notes[key] = await unpackBlobNote(await openAppDb(), raw, downloadContentBlob);
  return sortRecord(notes);
}

export async function mergeCategoryNotesRaw(notes: Record<string, string>): Promise<number> {
  const validNotes = sortRecord(Object.keys(notes).reduce<Record<string, string>>((result, key) => {
    if (isCategoryNoteKey(key) && typeof notes[key] === 'string') result[key] = notes[key];
    return result;
  }, {}));
  if (Object.keys(validNotes).length === 0) return Object.keys(await exportCategoryNotesRaw()).length;

  const existing = await exportCategoryNotesRaw();
  for (const [key, value] of Object.entries(validNotes)) {
    if (!shouldUseIncomingNote(existing[key], value)) continue;
    await saveCategoryNoteRaw(key, value);
    existing[key] = value;
  }
  return Object.keys(existing).length;
}

function shouldUseIncomingNote(currentRaw: string | undefined, incomingRaw: string): boolean {
  if (!currentRaw) return true;
  const currentUpdatedAt = getNoteUpdatedAt(currentRaw);
  const incomingUpdatedAt = getNoteUpdatedAt(incomingRaw);
  if (!currentUpdatedAt || !incomingUpdatedAt) return currentRaw !== incomingRaw;
  return incomingUpdatedAt >= currentUpdatedAt;
}

function getNoteUpdatedAt(raw: string): string | null {
  try {
    const value = (parseBlobNote(raw)?.value ?? JSON.parse(raw)) as { updatedAt?: unknown };
    return typeof value.updatedAt === 'string' ? value.updatedAt : null;
  } catch {
    return null;
  }
}
export function replaceCategoryNotesRaw(
  notes: Record<string, string>,
  options: { coordinationLockHeld?: boolean; establishAuthority?: boolean; onlyChanged?: boolean } = {},
): Promise<number> {
  const validNotes = sortRecord(Object.keys(notes).reduce<Record<string, string>>((result, key) => {
    if (isCategoryNoteKey(key) && typeof notes[key] === 'string' && isUsableNoteRaw(notes[key])) result[key] = notes[key];
    return result;
  }, {}));

  return enqueueCategoryNoteOperation(async () => {
    if (isIndexedDbAvailable()) {
      await replaceIndexedDbNotes(validNotes, options.onlyChanged);
      await cleanupNativeOriginals(await openCoLocatedNoteDb(), Object.fromEntries(collectLegacyLocalStorageNotes()));
      if (writeCategoryNotesManifestBestEffort(Object.keys(validNotes)) && options.establishAuthority) {
        safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
      }
      return Object.keys(validNotes).length;
    }

    if (options.onlyChanged) {
      collectLegacyLocalStorageNotesOrThrow(isCategoryNoteKey).forEach(([key]) => {
        if (!(key in validNotes)) localStorage.removeItem(key);
      });
    } else removeAllLegacyLocalStorageNotes();
    Object.entries(validNotes).forEach(([key, value]) => {
      if (!options.onlyChanged || localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    });
    if (writeCategoryNotesManifestBestEffort(Object.keys(validNotes)) && options.establishAuthority) {
      safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
    }
    return Object.keys(validNotes).length;
  }, options);
}

async function readDeletedNoteKeys(keys: string[]): Promise<Set<string>> {
  const deleted = new Set<string>();
  if (!keys.length || !isIndexedDbAvailable()) return deleted;
  const db = await openNoteDb();
  if (!db.objectStoreNames.contains('appRecords')) return deleted;
  await waitForCategoryNoteStorage(new Promise<void>((resolve, reject) => {
    const tx = db.transaction('appRecords', 'readonly');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Cannot verify deleted notes.'));
    for (const key of keys) {
      const request = tx.objectStore('appRecords').get(JSON.stringify(['indexedDbNotes', key]));
      request.onsuccess = () => {
        const row = request.result;
        if (row?.collection === 'indexedDbNotes' && row.id === key && row.raw === null) deleted.add(key);
      };
    }
  }));
  return deleted;
}

type CategoryNotesManifestRead =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; keys: string[] };

function readCategoryNotesManifest(): CategoryNotesManifestRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CATEGORY_NOTES_MANIFEST_KEY);
  } catch {
    return { kind: 'invalid' };
  }
  if (raw === null) return { kind: 'missing' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || (parsed as { version?: unknown }).version !== 1
      || !Array.isArray((parsed as { keys?: unknown }).keys)
    ) return { kind: 'invalid' };
    const keys = (parsed as { keys: unknown[] }).keys;
    if (keys.length > 10_000 || keys.some((key) => typeof key !== 'string' || !isCategoryNoteKey(key))) {
      return { kind: 'invalid' };
    }
    return { kind: 'valid', keys: Array.from(new Set(keys as string[])).sort() };
  } catch {
    return { kind: 'invalid' };
  }
}

function writeCategoryNotesManifest(keys: Iterable<string>): void {
  const normalizedKeys = Array.from(new Set(Array.from(keys).filter(isCategoryNoteKey))).sort();
  localStorage.setItem(CATEGORY_NOTES_MANIFEST_KEY, JSON.stringify({ version: 1, keys: normalizedKeys }));
}

async function ensureCategoryNoteManifestIncludes(key: string): Promise<void> {
  const manifest = readCategoryNotesManifest();
  if (manifest.kind === 'invalid') throw new Error('Failed to update the category note manifest.');
  if (manifest.kind === 'missing') {
    if (hasPersistedSyncHistory()) {
      markCategoryNotesRecoveryRequiredBestEffort('missing-manifest');
      throw new Error('Cannot bootstrap a missing note manifest after cloud sync.');
    }
    await refreshCategoryNotesManifest();
    return;
  }
  writeCategoryNotesManifest([...manifest.keys, key]);
}

async function ensureCategoryNoteManifestIncludesBestEffort(key: string): Promise<void> {
  try {
    await ensureCategoryNoteManifestIncludes(key);
  } catch {
    // The note itself is already durable. A missing/stale manifest makes the
    // next authoritative cloud export fail closed until it can be rebuilt.
  }
}

async function refreshCategoryNotesManifest(): Promise<void> {
  const existingManifest = readCategoryNotesManifest();
  if (existingManifest.kind === 'invalid') throw new Error('Invalid category note manifest.');
  if (existingManifest.kind === 'missing' && hasPersistedSyncHistory()) {
    markCategoryNotesRecoveryRequiredBestEffort('missing-manifest');
    throw new Error('Cannot rebuild a missing note manifest after cloud sync.');
  }
  const currentNotes = isIndexedDbAvailable() ? await exportIndexedDbNotes() : {};
  const localEntries = collectLegacyLocalStorageNotesOrThrow(isCategoryNoteKey);
  const invalidLocalEntry = localEntries.find(([, raw]) => !isUsableNoteRaw(raw));
  if (invalidLocalEntry) throw new Error(`Invalid local category note: ${invalidLocalEntry[0]}`);
  writeCategoryNotesManifest([
    ...Object.keys(currentNotes),
    ...localEntries.map(([key]) => key),
  ]);
}

async function recordCategoryNoteDeletionBestEffort(predicate: (key: string) => boolean): Promise<void> {
  try {
    const manifest = readCategoryNotesManifest();
    if (manifest.kind === 'valid') {
      writeCategoryNotesManifest(manifest.keys.filter((key) => !predicate(key)));
      return;
    }
    if (manifest.kind === 'invalid') {
      markCategoryNotesRecoveryRequiredBestEffort('invalid-manifest');
      return;
    }
    if (hasPersistedSyncHistory()) {
      markCategoryNotesRecoveryRequiredBestEffort('missing-manifest');
      return;
    }
    await refreshCategoryNotesManifest();
  } catch {
    // The durable scoped deletion succeeded. Keeping the old/missing manifest
    // makes a later authoritative export fail closed without legitimizing
    // unrelated notes that may also have disappeared.
  }
}

function writeCategoryNotesManifestBestEffort(keys: Iterable<string>): boolean {
  try {
    writeCategoryNotesManifest(keys);
    return true;
  } catch {
    return false;
  }
}

export function isCategoryNotesRecoveryRequired(): boolean {
  try {
    return localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY) !== null;
  } catch {
    return true;
  }
}

function markCategoryNotesRecoveryRequiredBestEffort(
  reason: 'backup-only' | 'missing-current' | 'missing-manifest' | 'invalid-manifest' | 'invalid-note' | 'read-failure',
  key?:string,
): void {
  try {
    const previous=JSON.parse(localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY)??'null');
    const notes=previous?.version===2?previous.notes??{}:{};
    const globalReason=previous?.version===2?previous.globalReason:previous?.reason;
    localStorage.setItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY, JSON.stringify({version:2,notes:{...notes,...(key?{[key]:reason}:{})},...(!key?{globalReason:reason}:globalReason?{globalReason}:{})}));
  } catch {
    // The manifest/history checks still keep authoritative exports closed.
  }
}

export function categoryNoteRecoveryKeys():string[]{
  try{const value=JSON.parse(localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY)??'null');return value?.version===2?Object.keys(value.notes??{}):[];}catch{return [];}
}

/** Called under the data lock before sync. Enumerate keys, not PDF/ink bodies;
 * repair only missing or previously quarantined projections. */
export async function repairCategoryNoteProjections():Promise<void>{
  if(!isIndexedDbAvailable())return;
  const owner=getAccountStorageSession(),native=globalThis.localStorage;
  const current=()=>{if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('ノートのアカウントが変わりました。');owner?.assertCurrent();};
  const db=await openNoteDb();if(!db.objectStoreNames.contains('appRecords'))return;
  current();
  const tx=db.transaction([NOTE_STORE_NAME,NOTE_BACKUP_STORE_NAME]);
  const currentKeys=tx.objectStore(NOTE_STORE_NAME).getAllKeys(),backupKeys=tx.objectStore(NOTE_BACKUP_STORE_NAME).getAllKeys();
  await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
  current();
  const present=new Set(currentKeys.result.map(String)),manifest=readCategoryNotesManifest();
  const missing=new Set([...categoryNoteRecoveryKeys(),...backupKeys.result.map(String).filter(key=>!present.has(key)),...(manifest.kind==='valid'?manifest.keys.filter(key=>!present.has(key)):[])].filter(isCategoryNoteKey));
  const unresolved:string[]=[],deleted=new Set<string>();
  for(const key of missing){
    const raw=await reconstructCanonicalNote(key,isUsableNoteRaw);
    current();
    if(raw===undefined)unresolved.push(key);
    else {clearCategoryNoteRecovery(key);if(raw===null)deleted.add(key);}
  }
  if(manifest.kind==='valid'){
    if(deleted.size)writeCategoryNotesManifest(manifest.keys.filter(key=>!deleted.has(key)));
    try{
      const marker=JSON.parse(localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY)??'null');
      // This complete key audit can scope an old backup/missing marker. Other
      // legacy failures (unreadable stores/manifests) remain unresolved.
      const globalReason=marker?.version===1?marker.reason:marker?.globalReason;
      if(['backup-only','missing-current'].includes(globalReason)){
        const notes=marker?.version===2?{...marker.notes}:{};
        for(const key of unresolved)notes[key]=backupKeys.result.includes(key)?'backup-only':'missing-current';
        if(Object.keys(notes).length)localStorage.setItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY,JSON.stringify({version:2,notes}));
        else safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
      }
    }catch{/* Retain unreadable provenance. */}
  }
  for(const key of unresolved)markCategoryNotesRecoveryRequiredBestEffort(backupKeys.result.includes(key)?'backup-only':'missing-current',key);
}

function clearCategoryNoteRecovery(key:string):void{
  try{
    const marker=JSON.parse(localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY)??'null');
    if(marker?.version!==2)return;
    const notes={...marker.notes};delete notes[key];
    if(!Object.keys(notes).length&&!marker.globalReason)safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
    else localStorage.setItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY,JSON.stringify({...marker,notes}));
  }catch{/* Keep uncertain recovery provenance. */}
}

/** Only an explicit user choice creates a new edit from a recovery candidate. */
export async function restoreCategoryNoteCandidate(key:string,expectedRaw:string):Promise<void>{
  await enqueueCategoryNoteOperation(async()=>{
    if(!isUsableNoteRaw(expectedRaw)||await getBackupRawFromIndexedDb(key)!==expectedRaw)throw new Error('復旧候補が変わりました。もう一度確認してください。');
    const current=await getRawFromIndexedDb(key);
    if(current!==null&&isUsableNoteRaw(current))throw new Error('ノートが更新されています。開き直して最新の内容を確認してください。');
    const value=JSON.parse(expectedRaw);value.updatedAt=new Date().toISOString();
    await saveCategoryNoteRawNow(key,JSON.stringify(value));
    clearCategoryNoteRecovery(key);
  });
}

function openNoteDb(forWrite = false): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) return Promise.reject(new Error('IndexedDB is not available.'));
  return openCoLocatedNoteDb(forWrite);
}

function abandonNoteDbConnection(): void {
  // Abort writes without closing the shared AppData connection. The epoch also
  // prevents a delayed migration read from starting a new write after timeout.
  abortPendingNoteTransactions();
}

export async function waitForCategoryNoteStorage<T>(
  pending: Promise<T>,
  timeoutMs = NOTE_STORAGE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new CategoryNoteStorageTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function getRawFromIndexedDb(key: string): Promise<string | null> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const hasRecords = db.objectStoreNames.contains('appRecords');
    const transaction = db.transaction(hasRecords ? [NOTE_STORE_NAME, 'appRecords'] : [NOTE_STORE_NAME], 'readonly');
    const record = hasRecords ? transaction.objectStore('appRecords').get(JSON.stringify(['indexedDbNotes', key])) : undefined;
    const request = transaction.objectStore(NOTE_STORE_NAME).get(key);
    transaction.oncomplete = () => {
      const row = record?.result;
      const deleted = row?.collection === 'indexedDbNotes' && row.id === key && row.raw === null;
      resolve(deleted ? null : typeof request.result === 'string' ? request.result : null);
    };
    transaction.onabort = () => reject(transaction.error ?? new Error('Failed to read note.'));
    request.onerror = () => reject(request.error ?? new Error('Failed to read note.'));
  });
}

async function getBackupRawFromIndexedDb(key: string): Promise<string | null> {
  const db = await openNoteDb();
  const raw = await new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(NOTE_BACKUP_STORE_NAME, 'readonly');
    const request = transaction.objectStore(NOTE_BACKUP_STORE_NAME).get(key);
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error('Failed to read note backup.'));
  });
  return raw && parseBlobNote(raw) ? unpackBlobNote(db, raw, downloadContentBlob) : raw;
}
async function setRawToIndexedDb(key: string, raw: string): Promise<void> {
  const db = await openNoteDb(true);
  if (await readMeta(db, 'deltaEnabled')) raw = await packBlobNote(db, raw);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(NOTE_RECORD_TRANSACTION_STORES, 'readwrite');
    const store = transaction.objectStore(NOTE_STORE_NAME);
    const backupStore = transaction.objectStore(NOTE_BACKUP_STORE_NAME);
    const currentRequest = store.get(key);
    currentRequest.onsuccess = () => {
      if (typeof currentRequest.result === 'string' && currentRequest.result !== raw && isUsableNoteRaw(currentRequest.result)) {
        backupStore.put(currentRequest.result, key);
        queueBlobReferences(transaction,`note-backup:${JSON.stringify(['indexedDbNotes',key])}`,currentRequest.result);
      }
      store.put(raw, key);
      queueNoteRecordWrite(transaction, key, raw);
    };
    currentRequest.onerror = () => reject(currentRequest.error ?? new Error('Failed to read note before saving.'));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to save note.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Failed to save note.'));
  });
}
async function exportIndexedDbNotes(allowInvalid = false): Promise<Record<string, string>> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const result: Record<string, string> = {};
    const transaction = db.transaction(NOTE_STORE_NAME, 'readonly');
    const request = transaction.objectStore(NOTE_STORE_NAME).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(sortRecord(result));
        return;
      }
      const key = String(cursor.key);
      if (isCategoryNoteKey(key)) {
        if (typeof cursor.value !== 'string' || !isUsableNoteRaw(cursor.value)) {
          if (!allowInvalid) {
            reject(new Error(`Invalid category note in IndexedDB: ${key}`));
            return;
          }
          markCategoryNotesRecoveryRequiredBestEffort('invalid-note',key);
          cursor.continue();
          return;
        }
        result[key] = cursor.value;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to export notes.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to export notes.'));
  });
}

async function exportIndexedDbNoteBackups(allowInvalid = false): Promise<Record<string, string>> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const result: Record<string, string> = {};
    const transaction = db.transaction(NOTE_BACKUP_STORE_NAME, 'readonly');
    const request = transaction.objectStore(NOTE_BACKUP_STORE_NAME).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(sortRecord(result));
        return;
      }
      const key = String(cursor.key);
      if (isCategoryNoteKey(key)) {
        if (typeof cursor.value !== 'string' || !isUsableNoteRaw(cursor.value)) {
          if (!allowInvalid) {
            reject(new Error(`Invalid category note backup in IndexedDB: ${key}`));
            return;
          }
          markCategoryNotesRecoveryRequiredBestEffort('invalid-note',key);
          cursor.continue();
          return;
        }
        result[key] = cursor.value;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to export note backups.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to export note backups.'));
  });
}

async function deleteIndexedDbNotesWhere(predicate: (key: string) => boolean, fallbackKeys: readonly string[] = []): Promise<Set<string>> {
  const db = await openNoteDb(true);
  return new Promise((resolve, reject) => {
    const deletedKeys = new Set<string>();
    const transaction = db.transaction(NOTE_RECORD_TRANSACTION_STORES, 'readwrite');

    const markDeleted = (key: string) => {
      if (deletedKeys.has(key)) return;
      deletedKeys.add(key);
      queueNoteRecordWrite(transaction, key, null);
      queueBlobReferences(transaction, `note-backup:${JSON.stringify(['indexedDbNotes', key])}`, null);
      transaction.objectStore('appRecordMeta').delete(`materialOffline:${key}`);
      transaction.objectStore('appRecordMeta').delete(`materialCache:${key}`);
    };
    fallbackKeys.filter(predicate).forEach(markDeleted);
    // Include canonical-only rows: a missing projection must not turn a
    // successful library deletion into a later automatic reconstruction.
    [NOTE_STORE_NAME, NOTE_BACKUP_STORE_NAME, 'appRecords'].forEach((storeName) => {
      const request = transaction.objectStore(storeName).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const canonical = storeName === 'appRecords';
        const key = canonical
          ? cursor.value.collection === 'indexedDbNotes' && cursor.value.raw !== null ? cursor.value.id : ''
          : String(cursor.key);
        if (predicate(key)) {
          if (storeName !== 'appRecords') cursor.delete();
          markDeleted(key);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to inspect category notes for deletion.'));
    });

    transaction.oncomplete = () => resolve(deletedKeys);
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to delete category notes.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Failed to delete category notes.'));
  });
}

async function replaceIndexedDbNotes(notes: Record<string, string>, onlyChanged = false): Promise<void> {
  const db = await openNoteDb(true);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(NOTE_RECORD_TRANSACTION_STORES, 'readwrite');
    const store = transaction.objectStore(NOTE_STORE_NAME);
    const backupStore = transaction.objectStore(NOTE_BACKUP_STORE_NAME);
    // Preserve previous note versions and mutate only changed values. Even a
    // recovery import must leave tombstones for records absent from its snapshot.
    // Record backups retain rejected values; the legacy timestamp-selected backup
    // must not supersede an explicitly imported older version.
    backupStore.clear();
    const remaining = new Set(Object.keys(notes));
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        remaining.forEach(key => { store.put(notes[key], key); queueNoteRecordWrite(transaction, key, notes[key]); });
        return;
      }
      const key = String(cursor.key);
      if (!(key in notes) || cursor.value !== notes[key]) {
        if (!(key in notes)) cursor.delete();
        else cursor.update(notes[key]);
        queueNoteRecordWrite(transaction, key, key in notes ? notes[key] : null);
      }
      remaining.delete(key);
      cursor.continue();
    };
    void onlyChanged;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to import notes.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Failed to import notes.'));
  });
}

function collectLegacyLocalStorageNotes(): Array<[string, string]> {
  const notes: Array<[string, string]> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !isCategoryNoteKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) notes.push([key, value]);
    }
  } catch {
    // localStorage may be unavailable in private/restricted contexts.
  }
  return notes;
}

function collectLegacyLocalStorageNotesOrThrow(predicate: (key: string) => boolean): Array<[string, string]> {
  if (typeof localStorage === 'undefined') return [];
  const notes: Array<[string, string]> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !predicate(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) notes.push([key, value]);
    }
    return notes;
  } catch (error) {
    throw new Error(`Failed to inspect local category notes. ${getErrorMessage(error)}`);
  }
}

function removeLegacyLocalStorageNotesOrThrow(notes: Array<[string, string]>): void {
  if (notes.length === 0) return;
  const removed: Array<[string, string]> = [];
  try {
    notes.forEach(([key, value]) => {
      localStorage.removeItem(key);
      removed.push([key, value]);
    });
  } catch (error) {
    try {
      restoreLegacyLocalStorageNotes(removed);
    } catch (rollbackError) {
      throw new Error(
        `Failed to delete local category notes and restore the notes already removed. `
        + `Delete error: ${getErrorMessage(error)} Restore error: ${getErrorMessage(rollbackError)}`,
      );
    }
    throw new Error(`Failed to delete local category notes. ${getErrorMessage(error)}`);
  }
}

function restoreLegacyLocalStorageNotes(notes: Array<[string, string]>): void {
  notes.forEach(([key, value]) => localStorage.setItem(key, value));
}

function removeAllLegacyLocalStorageNotes(): void {
  collectLegacyLocalStorageNotes().forEach(([key]) => safeLocalStorageRemove(key));
}

function readLocalStorageValue(key: string): { value: string | null; error: unknown | null } {
  try {
    return { value: localStorage.getItem(key), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function createCategoryNoteReadError(cause: unknown): Error {
  return new Error(`Failed to read category note data. ${getErrorMessage(cause)}`);
}

function safeLocalStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort cleanup only.
  }
}

function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.message.toLowerCase().includes('quota')
    || error.message.includes('exceeded the quota');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pickNewestNoteRaw(candidates: Array<string | null>): string | null {
  const validCandidates = candidates.filter((candidate): candidate is string => candidate !== null && isUsableNoteRaw(candidate));
  if (validCandidates.length === 0) return null;
  return validCandidates.reduce((newest, candidate) => {
    const newestUpdatedAt = getNoteUpdatedAt(newest);
    const candidateUpdatedAt = getNoteUpdatedAt(candidate);
    if (!newestUpdatedAt || !candidateUpdatedAt) return candidate;
    return candidateUpdatedAt >= newestUpdatedAt ? candidate : newest;
  });
}
function isUsableNoteRaw(raw: string): boolean {
  if (parseBlobNote(raw)) return true;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return false;
    if (value.kind === 'quiz-material-index' || value.kind === 'quiz-material-file' || value.kind === 'quiz-material-remote-file') return validMaterialRecord(value);
    if (Array.isArray(value.pages)) {
      return value.pages.length > 0
        && value.pages.every((page) => (
          isRecord(page)
          && typeof page.id === 'string'
          && typeof page.dataUrl === 'string'
          && typeof page.updatedAt === 'string'
        ))
        && typeof value.problemSetId === 'string'
        && typeof value.category === 'string'
        && Number.isInteger(value.currentPageIndex)
        && (value.currentPageIndex as number) >= 0
        && (value.currentPageIndex as number) < value.pages.length
        && typeof value.updatedAt === 'string';
    }
    return typeof value.dataUrl === 'string';
  } catch {
    return false;
  }
}

export function isValidCategoryNoteRaw(raw: string): boolean {
  return isUsableNoteRaw(raw);
}
function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.keys(record).sort().reduce<Record<string, string>>((result, key) => {
    result[key] = record[key];
    return result;
  }, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
