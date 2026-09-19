import { advanceLocalDataRevision } from './localDataRevision';
import { validMaterialRecord } from './materialModel';
import { loadLatestCoordinatedData, withCoordinatedDataMutation } from './dataCoordination';
import { hasPersistedSyncHistory } from './syncState';

const NOTE_DB_NAME = 'quiz-make-notes-v1';
const NOTE_STORE_NAME = 'categoryNotes';
const NOTE_BACKUP_STORE_NAME = 'categoryNoteBackups';
const NOTE_STORAGE_OPERATION_TIMEOUT_MS = 4_500;
export const CATEGORY_NOTE_KEY_PREFIX = 'quizMake:notes:';
export const CATEGORY_NOTES_MANIFEST_KEY = 'quiz-make-note-storage-v1:manifest';
export const CATEGORY_NOTES_RECOVERY_REQUIRED_KEY = 'quiz-make-note-storage-v1:recovery-required';

export class CategoryNoteStorageTimeoutError extends Error {
  constructor() {
    super('Category note storage operation timed out.');
    this.name = 'CategoryNoteStorageTimeoutError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;
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

export async function loadCategoryNoteRaw(key: string): Promise<string | null> {
  if (!isCategoryNoteKey(key)) return null;
  await waitForPendingCategoryNoteSaves();
  return loadLatestCoordinatedData(['notes'], () => loadCategoryNoteRawUnlocked(key));
}

async function loadCategoryNoteRawUnlocked(key: string): Promise<string | null> {
  let indexedCurrent: string | null = null;
  let indexedBackup: string | null = null;
  let indexedCurrentError: unknown = null;
  let indexedBackupError: unknown = null;
  if (isIndexedDbAvailable()) {
    const [currentRead, backupRead] = await Promise.allSettled([
      waitForCategoryNoteStorage(getRawFromIndexedDb(key)),
      waitForCategoryNoteStorage(getBackupRawFromIndexedDb(key)),
    ]);
    if (currentRead.status === 'fulfilled') indexedCurrent = currentRead.value;
    else {
      indexedCurrentError = currentRead.reason;
      console.warn('Failed to read the current category note from IndexedDB.', currentRead.reason);
    }
    if (backupRead.status === 'fulfilled') indexedBackup = backupRead.value;
    else {
      indexedBackupError = backupRead.reason;
      console.warn('Failed to read the category note backup from IndexedDB.', backupRead.reason);
    }
    if (indexedCurrentError instanceof CategoryNoteStorageTimeoutError
      || indexedBackupError instanceof CategoryNoteStorageTimeoutError) {
      abandonNoteDbConnection();
    }
  }

  const legacyRead = readLocalStorageValue(key);
  const legacy = legacyRead.value;
  const authoritativePreferred = pickNewestNoteRaw([indexedCurrent, legacy]);
  const preferred = authoritativePreferred ?? pickNewestNoteRaw([indexedBackup]);
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
  if (indexedBackupError && preferred === null) {
    throw createCategoryNoteReadError(indexedBackupError);
  }
  if (preferred === null) {
    if (indexedCurrent !== null || indexedBackup !== null || legacy !== null) {
      throw createCategoryNoteReadError(new Error('Stored category note data is invalid.'));
    }
    const manifest = readCategoryNotesManifest();
    if (manifest.kind === 'valid' && manifest.keys.includes(key)) {
      markCategoryNotesRecoveryRequiredBestEffort('missing-current');
    }
    return null;
  }

  if (!hasValidCurrent && !hasValidLegacy && indexedBackup !== null) {
    markCategoryNotesRecoveryRequiredBestEffort('backup-only');
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
      ? await deleteIndexedDbNotesWhere(predicate)
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
      safeLocalStorageRemove(key);
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
  options: { coordinationLockHeld?: boolean; mode?: 'authoritative' | 'recovery' } = {},
): Promise<Record<string, string>> {
  if (!options.coordinationLockHeld) await waitForPendingCategoryNoteSaves();
  let indexedNotes: Record<string, string> = {};
  let indexedBackups: Record<string, string> = {};

  if (isIndexedDbAvailable()) {
    try {
      indexedNotes = await exportIndexedDbNotes(options.mode === 'recovery');
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
      indexedBackups = await exportIndexedDbNoteBackups(options.mode === 'recovery');
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
    markCategoryNotesRecoveryRequiredBestEffort('invalid-note');
    if (options.mode !== 'recovery') {
      throw new Error(`端末のノートデータが破損しているため、バックアップを中止しました: ${invalidLocalFallback[0]}`);
    }
  }
  const localFallbacks = Object.fromEntries(localFallbackEntries.filter(([, raw]) => isUsableNoteRaw(raw)));
  const backupOnlyKey = Object.keys(indexedBackups).find((key) => (
    indexedNotes[key] === undefined && localFallbacks[key] === undefined
  ));
  const authoritativeKeys = new Set([
    ...Object.keys(indexedNotes),
    ...Object.keys(localFallbacks),
    ...(options.mode === 'recovery' ? Object.keys(indexedBackups) : []),
  ]);
  const notes: Record<string, string> = {};
  authoritativeKeys.forEach((key) => {
    const authoritative = pickNewestNoteRaw([
      indexedNotes[key] ?? null,
      localFallbacks[key] ?? null,
    ]);
    const newest = authoritative
      ?? (options.mode === 'recovery' ? pickNewestNoteRaw([indexedBackups[key] ?? null]) : null);
    if (newest !== null) notes[key] = newest;
  });

  if (backupOnlyKey) {
    markCategoryNotesRecoveryRequiredBestEffort('backup-only');
    if (options.mode !== 'recovery') {
      throw new Error('端末のノートが復旧用バックアップにしか残っていないため、古い内容や欠けた内容でクラウドを上書きしないよう保存を中止しました。');
    }
  }

  if (isCategoryNotesRecoveryRequired() && options.mode !== 'recovery') {
    throw new Error('端末のノートは復旧確認が必要な状態です。欠けた内容でクラウドを上書きしないよう保存を中止しました。先にクラウドから読み込むか、バックアップを確認してください。');
  }

  const manifest = readCategoryNotesManifest();
  if (manifest.kind === 'invalid') {
    markCategoryNotesRecoveryRequiredBestEffort('invalid-manifest');
    if (options.mode !== 'recovery') {
      throw new Error('ノートの保存状態を確認できないため、クラウド保存を中止しました。');
    }
  }
  if (manifest.kind === 'valid') {
    const missingExpectedKey = manifest.keys.find((key) => notes[key] === undefined);
    if (missingExpectedKey) {
      markCategoryNotesRecoveryRequiredBestEffort('missing-current');
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
    const value = JSON.parse(raw) as { updatedAt?: unknown };
    return typeof value.updatedAt === 'string' ? value.updatedAt : null;
  } catch {
    return null;
  }
}
export function replaceCategoryNotesRaw(
  notes: Record<string, string>,
  options: { coordinationLockHeld?: boolean; establishAuthority?: boolean } = {},
): Promise<number> {
  const validNotes = sortRecord(Object.keys(notes).reduce<Record<string, string>>((result, key) => {
    if (isCategoryNoteKey(key) && typeof notes[key] === 'string' && isUsableNoteRaw(notes[key])) result[key] = notes[key];
    return result;
  }, {}));

  return enqueueCategoryNoteOperation(async () => {
    if (isIndexedDbAvailable()) {
      await replaceIndexedDbNotes(validNotes);
      removeAllLegacyLocalStorageNotes();
      if (writeCategoryNotesManifestBestEffort(Object.keys(validNotes)) && options.establishAuthority) {
        safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
      }
      return Object.keys(validNotes).length;
    }

    removeAllLegacyLocalStorageNotes();
    Object.entries(validNotes).forEach(([key, value]) => localStorage.setItem(key, value));
    if (writeCategoryNotesManifestBestEffort(Object.keys(validNotes)) && options.establishAuthority) {
      safeLocalStorageRemove(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
    }
    return Object.keys(validNotes).length;
  }, options);
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

function isCategoryNotesRecoveryRequired(): boolean {
  try {
    return localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY) !== null;
  } catch {
    return true;
  }
}

function markCategoryNotesRecoveryRequiredBestEffort(
  reason: 'backup-only' | 'missing-current' | 'missing-manifest' | 'invalid-manifest' | 'invalid-note' | 'read-failure',
): void {
  try {
    localStorage.setItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY, JSON.stringify({ version: 1, reason }));
  } catch {
    // The manifest/history checks still keep authoritative exports closed.
  }
}

function openNoteDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) return Promise.reject(new Error('IndexedDB is not available.'));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(NOTE_DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTE_STORE_NAME)) db.createObjectStore(NOTE_STORE_NAME);
      if (!db.objectStoreNames.contains(NOTE_BACKUP_STORE_NAME)) db.createObjectStore(NOTE_BACKUP_STORE_NAME);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open note database.'));
    request.onblocked = () => reject(new Error('Note database is blocked by another tab.'));
  });

  const opening = dbPromise;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });

  return opening;
}

function abandonNoteDbConnection(): void {
  const abandoned = dbPromise;
  dbPromise = null;
  void abandoned?.then(
    (db) => db.close(),
    () => undefined,
  );
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
    const transaction = db.transaction(NOTE_STORE_NAME, 'readonly');
    const request = transaction.objectStore(NOTE_STORE_NAME).get(key);
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error('Failed to read note.'));
  });
}

async function getBackupRawFromIndexedDb(key: string): Promise<string | null> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(NOTE_BACKUP_STORE_NAME, 'readonly');
    const request = transaction.objectStore(NOTE_BACKUP_STORE_NAME).get(key);
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error('Failed to read note backup.'));
  });
}
async function setRawToIndexedDb(key: string, raw: string): Promise<void> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([NOTE_STORE_NAME, NOTE_BACKUP_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(NOTE_STORE_NAME);
    const backupStore = transaction.objectStore(NOTE_BACKUP_STORE_NAME);
    const currentRequest = store.get(key);
    currentRequest.onsuccess = () => {
      if (typeof currentRequest.result === 'string' && currentRequest.result !== raw) {
        backupStore.put(currentRequest.result, key);
      }
      store.put(raw, key);
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
          markCategoryNotesRecoveryRequiredBestEffort('invalid-note');
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
          markCategoryNotesRecoveryRequiredBestEffort('invalid-note');
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

async function deleteIndexedDbNotesWhere(predicate: (key: string) => boolean): Promise<Set<string>> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const deletedKeys = new Set<string>();
    const transaction = db.transaction([NOTE_STORE_NAME, NOTE_BACKUP_STORE_NAME], 'readwrite');

    [NOTE_STORE_NAME, NOTE_BACKUP_STORE_NAME].forEach((storeName) => {
      const request = transaction.objectStore(storeName).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (predicate(key)) {
          cursor.delete();
          deletedKeys.add(key);
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

async function replaceIndexedDbNotes(notes: Record<string, string>): Promise<void> {
  const db = await openNoteDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([NOTE_STORE_NAME, NOTE_BACKUP_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(NOTE_STORE_NAME);
    const backupStore = transaction.objectStore(NOTE_BACKUP_STORE_NAME);
    store.clear();
    backupStore.clear();
    Object.entries(notes).forEach(([key, value]) => store.put(value, key));
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
