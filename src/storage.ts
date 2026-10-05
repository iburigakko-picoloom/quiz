import { accountLocalStorage as localStorage, accountDatabaseName, assertAccountStorageCurrent } from './utils/accountStorage';
import type { AppData } from './types';
import { normalizeAppData } from './utils/appDataValidation';
import { loadLatestCoordinatedData, withCoordinatedDataMutation } from './utils/dataCoordination';
import { advanceLocalDataRevision } from './utils/localDataRevision';
import { hasPersistedSyncHistory } from './utils/syncState';
import { readAppRecords, readPreviousAppRecords, saveAppRecords, upgradeAppRecordStores } from './utils/appRecordStorage';
import { appSaveFailure, type AppSaveFailure } from './utils/appSaveFailure';
import { cleanupNativeOriginals } from './utils/learningValueStorage';

export const APP_DATA_STORAGE_KEY = 'quiz-make-app-data-v1';
export const APP_DATA_FALLBACK_META_KEY = 'quiz-make-app-data-v1:fallback-saved-at';
export const APP_DATA_EXPECTED_KEY = 'quiz-make-app-data-v1:expected';
export const APP_DATA_RECOVERY_REQUIRED_KEY = 'quiz-make-app-data-v1:recovery-required';
const APP_DATA_FALLBACK_RECORD_KEY = 'quiz-make-app-data-v1:fallback-record';
async function cleanupLegacyAppData() {
  const originals = Object.fromEntries([APP_DATA_STORAGE_KEY, APP_DATA_FALLBACK_META_KEY, APP_DATA_FALLBACK_RECORD_KEY].map(key => [key, localStorage.getItem(key)]));
  await cleanupNativeOriginals(await openAppDb(), originals);
}

const APP_DB_NAME = 'quiz-make-app-data-v1';
const APP_STORE_NAME = 'appData';
const APP_BACKUP_STORE_NAME = 'appDataBackups';
const APP_DATA_IDB_SAVED_AT_KEY = `${APP_DATA_STORAGE_KEY}:saved-at`;
let appDbPromise: Promise<IDBDatabase> | null = null;
let appSaveQueue: Promise<boolean> = Promise.resolve(true);

type IndexedAppDataRecord = {
  raw: string | null;
  savedAt: string | null;
  source: 'current' | 'backup' | 'invalid' | 'empty';
};

export function createEmptyAppData(): AppData {
  return {
    version: 1,
    folders: [],
    problemSets: [],
    questions: [],
    progress: [],
    answerLogs: [],
  };
}

export function loadAppData(): AppData {
  const raw = getLocalFallbackRecord().raw;
  if (!raw) return createEmptyAppData();
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = normalizeAppData(parsed);
    if (result.ok) return result.data;
    throw new Error(result.error);
  } catch (error) {
    console.error('Failed to load Quiz make data.', error);
    throw new Error(`保存データを読み込めませんでした。空のデータでは上書きしていません。${error instanceof Error ? ` (${error.message})` : ''}`);
  }
}

export async function loadAppDataAsync(
  options: { coordinationLockHeld?: boolean } = {},
): Promise<AppData> {
  if (options.coordinationLockHeld) return loadAppDataUnlocked();
  await waitForPendingAppDataSaves();
  return loadLatestCoordinatedData(['app'], loadAppDataUnlocked);
}

async function loadAppDataUnlocked(): Promise<AppData> {
  let indexedDbReadError: unknown = null;
  const indexedRecord = await getAppDataRecordFromIndexedDb().catch((error): IndexedAppDataRecord => {
    console.warn('Failed to load Quiz make data from IndexedDB.', error);
    indexedDbReadError = error;
    return { raw: null, savedAt: null, source: 'empty' };
  });
  const fallbackRecord = getLocalFallbackRecord();
  const fallbackRaw = fallbackRecord.raw;
  const preferredRaw = pickPreferredAppDataRaw(
    indexedRecord.raw,
    indexedRecord.savedAt,
    fallbackRaw,
    fallbackRecord.savedAt,
  );
  const preferredData = tryParseAppDataRaw(preferredRaw);
  if (!preferredData) {
    const unreadableStoredDataExists = indexedRecord.raw !== null || fallbackRaw !== null;
    if (indexedDbReadError || unreadableStoredDataExists) {
      if (isAppDataExpected() || hasPersistedSyncHistory()) {
        markAppDataRecoveryRequiredBestEffort('missing-primary');
        return createEmptyAppData();
      }
      throw new Error(
        unreadableStoredDataExists
          ? '保存データを読み取れませんでした。空のデータで上書きせず、読み込みを停止しました。'
          : '端末の保存領域へ接続できませんでした。空のデータで上書きせず、読み込みを停止しました。',
      );
    }
    if (isAppDataExpected() || hasPersistedSyncHistory()) {
      markAppDataRecoveryRequiredBestEffort('missing-primary');
    }
    return createEmptyAppData();
  }

  const usesDurableFallback = preferredRaw === fallbackRaw && tryParseAppDataRaw(fallbackRaw) !== null;
  if (!usesDurableFallback && indexedRecord.source === 'backup') {
    markAppDataRecoveryRequiredBestEffort('backup-only');
  }
  if (usesDurableFallback || indexedRecord.source === 'current') {
    markAppDataExpectedBestEffort(indexedRecord.savedAt ?? fallbackRecord.savedAt ?? new Date().toISOString());
  }

  if (preferredRaw !== fallbackRaw) await cleanupLegacyAppData();
  return preferredData;
}

export function saveAppData(data: AppData): Promise<boolean> {
  return saveAppDataAsync(data);
}

/** A per-call result keeps concurrent saves' failure reasons separate. */
export async function saveAppDataResult(data: AppData): Promise<{ ok: true } | { ok: false; failure: AppSaveFailure }> {
  let failure: AppSaveFailure | undefined;
  const saved = await saveAppDataAsync(data, { onFailure: value => { failure = value; } });
  return saved ? { ok: true } : { ok: false, failure: failure ?? appSaveFailure([{ stage: 'indexeddb', error: new Error() }]) };
}

export function establishCurrentAppDataAuthority(): boolean {
  try {
    markAppDataExpected(new Date().toISOString());
    localStorage.removeItem(APP_DATA_RECOVERY_REQUIRED_KEY);
    return localStorage.getItem(APP_DATA_EXPECTED_KEY) !== null
      && localStorage.getItem(APP_DATA_RECOVERY_REQUIRED_KEY) === null;
  } catch {
    return false;
  }
}

export async function saveAppDataAsync(
  data: AppData,
  options: { coordinationLockHeld?: boolean; onFailure?: (failure: AppSaveFailure) => void } = {},
): Promise<boolean> {
  if (options.coordinationLockHeld) return saveAppDataNow(data, options.onFailure);
  const queuedSave = appSaveQueue
    .catch(() => true)
    .then(async () => {
      try {
        return await withCoordinatedDataMutation(['app'], () => saveAppDataNow(data, options.onFailure));
      } catch (error) {
        console.error('Refused to overwrite app data changed in another tab.', error);
        try { options.onFailure?.(appSaveFailure([{ stage: 'coordination', error }])); } catch { /* Informational only. */ }
        return false;
      }
    });
  appSaveQueue = queuedSave;
  return queuedSave;
}

export async function waitForPendingAppDataSaves(): Promise<boolean> {
  try {
    return await appSaveQueue;
  } catch {
    return false;
  }
}

async function saveAppDataNow(data: AppData, onFailure?: (failure: AppSaveFailure) => void): Promise<boolean> {
  const normalized = normalizeAppData(data);
  if (!normalized.ok) {
    console.error('Refused to save invalid Quiz make data.');
    try { onFailure?.(appSaveFailure([{ stage: 'validation', error: new Error() }], normalized.error)); } catch { /* Informational only. */ }
    return false;
  }
  const savedAt = new Date().toISOString();
  const attempts: Array<{ stage: 'indexeddb' | 'fallback'; error: unknown }> = [];

  if (isIndexedDbAvailable()) {
    try {
      await saveAppRecords(await openAppDb(), normalized.data, savedAt, getLocalFallbackRecord);
      markAppDataExpectedBestEffort(savedAt);
      await cleanupLegacyAppData();
      advanceLocalDataRevision();
      return true;
    } catch (error) {
      console.error('Failed to save Quiz make data to IndexedDB.', error);
      attempts.push({ stage: 'indexeddb', error });
    }
  }

  try {
    const raw = JSON.stringify(normalized.data);
    // Keep payload and timestamp in one localStorage value so a quota failure
    // cannot leave a new payload paired with a missing or stale timestamp.
    localStorage.setItem(APP_DATA_FALLBACK_RECORD_KEY, JSON.stringify({ raw, savedAt }));
    markAppDataExpectedBestEffort(savedAt);
    safeLocalStorageRemove(APP_DATA_STORAGE_KEY);
    safeLocalStorageRemove(APP_DATA_FALLBACK_META_KEY);
    advanceLocalDataRevision();
    return true;
  } catch (error) {
    console.error('Failed to save Quiz make data.', error);
    attempts.push({ stage: 'fallback', error });
    try { onFailure?.(appSaveFailure(attempts)); } catch { /* Informational only. */ }
    return false;
  }
}

export async function exportAppDataRaw(
  options: { coordinationLockHeld?: boolean; mode?: 'authoritative' | 'recovery' } = {},
): Promise<string> {
  if (!options.coordinationLockHeld && !await waitForPendingAppDataSaves()) {
    throw new Error('最新の問題データを端末へ保存できていないため、バックアップを作成できません。');
  }
  let indexedDbReadError: unknown = null;
  const indexedRecord = await getAppDataRecordFromIndexedDb().catch((error): IndexedAppDataRecord => {
    indexedDbReadError = error;
    return { raw: null, savedAt: null, source: 'empty' };
  });
  const fallbackRecord = getLocalFallbackRecord();
  const fallbackRaw = fallbackRecord.raw;
  if (indexedDbReadError && !tryParseAppDataRaw(fallbackRaw)) {
    markAppDataRecoveryRequiredBestEffort('missing-primary');
    if (options.mode !== 'recovery') {
      throw new Error('端末の問題データを読み取れないため、空のバックアップで上書きしないよう作成を中止しました。');
    }
  }
  const preferredRaw = pickPreferredAppDataRaw(
    indexedRecord.raw,
    indexedRecord.savedAt,
    fallbackRaw,
    fallbackRecord.savedAt,
  );
  if (tryParseAppDataRaw(preferredRaw)) {
    const usesDurableFallback = preferredRaw === fallbackRaw && tryParseAppDataRaw(fallbackRaw) !== null;
    if (!usesDurableFallback && indexedRecord.source !== 'current') {
      markAppDataRecoveryRequiredBestEffort('backup-only');
      if (options.mode !== 'recovery') {
        throw new Error('端末の問題データが復旧用バックアップから読み込まれたため、古い内容でクラウドを上書きしないよう保存を中止しました。内容を確認し、必要ならクラウドから読み込んでください。');
      }
    }
    if (isAppDataRecoveryRequired() && options.mode !== 'recovery') {
      throw new Error('端末の問題データは復旧確認が必要な状態です。古い内容でクラウドを上書きしないよう保存を中止しました。先にクラウドから読み込むか、バックアップを確認してください。');
    }
    if (options.mode !== 'recovery') {
      markAppDataExpected(indexedRecord.savedAt ?? fallbackRecord.savedAt ?? new Date().toISOString());
    }
    return preferredRaw as string;
  }

  if (
    indexedRecord.raw !== null
    || fallbackRaw !== null
    || isAppDataExpected()
    || isAppDataRecoveryRequired()
    || hasPersistedSyncHistory()
  ) {
    markAppDataRecoveryRequiredBestEffort('missing-primary');
    if (options.mode !== 'recovery') {
      throw new Error('保存データを確認できないため、空のバックアップには置き換えませんでした。');
    }
  }

  return JSON.stringify(createEmptyAppData());
}

export async function importAppDataRaw(
  raw: string,
  options: { coordinationLockHeld?: boolean; establishAuthority?: boolean } = {},
): Promise<boolean> {
  const data = tryParseAppDataRaw(raw);
  if (!data) return false;
  const saved = await saveAppDataAsync(data, options);
  if (saved && options.establishAuthority) safeLocalStorageRemove(APP_DATA_RECOVERY_REQUIRED_KEY);
  return saved;
}

export function isAppData(value: unknown): value is AppData {
  return normalizeAppData(value).ok;
}

export function parseBackupJson(text: string): { ok: true; data: AppData } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    const result = normalizeAppData(parsed);
    if (!result.ok) {
      return {
        ok: false,
        error: `AppData形式を安全に読み込めません: ${result.error}`,
      };
    }
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `JSONの解析に失敗しました: ${error.message}` : 'JSONの解析に失敗しました。' };
  }
}

function tryParseAppDataRaw(raw: string | null): AppData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = normalizeAppData(parsed);
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

function pickPreferredAppDataRaw(
  indexedRaw: string | null,
  indexedSavedAtRaw: string | null,
  fallbackRaw: string | null,
  fallbackSavedAtRaw: string | null,
): string | null {
  const indexedData = tryParseAppDataRaw(indexedRaw);
  const fallbackData = tryParseAppDataRaw(fallbackRaw);
  if (!indexedData) return fallbackData ? fallbackRaw : null;
  if (!fallbackData) return indexedRaw;

  const indexedSavedAt = Date.parse(indexedSavedAtRaw ?? '');
  const fallbackSavedAt = Date.parse(fallbackSavedAtRaw ?? '');
  if (Number.isFinite(indexedSavedAt) && Number.isFinite(fallbackSavedAt)) {
    return fallbackSavedAt >= indexedSavedAt ? fallbackRaw : indexedRaw;
  }
  if (Number.isFinite(fallbackSavedAt)) return fallbackRaw;
  // A valid legacy fallback exists specifically because an IndexedDB save did
  // not complete. If its old two-key timestamp is missing, retain the payload
  // instead of silently reverting to IndexedDB.
  if (Number.isFinite(indexedSavedAt)) return fallbackRaw;

  const indexedFreshness = getAppDataFreshness(indexedData);
  const fallbackFreshness = getAppDataFreshness(fallbackData);
  return fallbackFreshness >= indexedFreshness ? fallbackRaw : indexedRaw;
}

function getAppDataFreshness(data: AppData): number {
  const timestamps = [
    ...data.folders.flatMap((item) => [item.createdAt, item.updatedAt]),
    ...data.problemSets.flatMap((item) => [item.createdAt, item.updatedAt]),
    ...data.questions.flatMap((item) => [item.createdAt, item.updatedAt]),
    ...data.progress.flatMap((item) => item.lastAnsweredAt ? [item.lastAnsweredAt] : []),
    ...data.answerLogs.map((item) => item.answeredAt),
  ];
  return timestamps.reduce((latest, value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
}

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openAppDb(): Promise<IDBDatabase> {
  assertAccountStorageCurrent();
  if (!isIndexedDbAvailable()) return Promise.reject(new Error('IndexedDB is not available.'));
  if (appDbPromise) return appDbPromise;

  appDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(accountDatabaseName(APP_DB_NAME), 7);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(APP_STORE_NAME)) db.createObjectStore(APP_STORE_NAME);
      if (!db.objectStoreNames.contains(APP_BACKUP_STORE_NAME)) db.createObjectStore(APP_BACKUP_STORE_NAME);
      upgradeAppRecordStores(db);
    };
    let blocked = false;
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); appDbPromise = null; };
      db.onclose = () => { appDbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open app data database.'));
    request.onblocked = () => { blocked = true; reject(new Error('App data database is blocked by another tab.')); };
  });

  appDbPromise.catch(() => {
    appDbPromise = null;
  });

  return appDbPromise;
}

async function getAppDataRecordFromIndexedDb(): Promise<IndexedAppDataRecord> {
  if (!isIndexedDbAvailable()) return { raw: null, savedAt: null, source: 'empty' };
  const db = await openAppDb();
  let recordReadError: unknown;
  try {
    const records = await readAppRecords(db);
    if (records) return { raw: JSON.stringify(records.data), savedAt: records.savedAt, source: 'current' };
  } catch (error) {
    recordReadError = error;
    const previous = await readPreviousAppRecords(db).catch(() => null);
    if (previous) return { raw: JSON.stringify(previous.data), savedAt: previous.savedAt, source: 'backup' };
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([APP_STORE_NAME, APP_BACKUP_STORE_NAME], 'readonly');
    const store = transaction.objectStore(APP_STORE_NAME);
    const backupStore = transaction.objectStore(APP_BACKUP_STORE_NAME);
    const request = store.get(APP_DATA_STORAGE_KEY);
    request.onsuccess = () => {
      if (typeof request.result === 'string' && tryParseAppDataRaw(request.result)) {
        const savedAtRequest = store.get(APP_DATA_IDB_SAVED_AT_KEY);
        savedAtRequest.onsuccess = () => resolve({
          raw: request.result,
          savedAt: typeof savedAtRequest.result === 'string' ? savedAtRequest.result : null,
          source: recordReadError ? 'backup' : 'current',
        });
        savedAtRequest.onerror = () => reject(savedAtRequest.error ?? new Error('Failed to read app data timestamp.'));
        return;
      }
      const backupRequest = backupStore.get(APP_DATA_STORAGE_KEY);
      backupRequest.onsuccess = () => {
        const currentRaw = typeof request.result === 'string' ? request.result : null;
        const backupRaw = typeof backupRequest.result === 'string' ? backupRequest.result : null;
        if (backupRaw && tryParseAppDataRaw(backupRaw)) {
          resolve({ raw: backupRaw, savedAt: null, source: 'backup' });
          return;
        }
        const invalidRaw = currentRaw ?? backupRaw;
        if (recordReadError && invalidRaw === null) { reject(recordReadError); return; }
        resolve({
          raw: invalidRaw,
          savedAt: null,
          source: invalidRaw === null ? 'empty' : 'invalid',
        });
      };
      backupRequest.onerror = () => reject(backupRequest.error ?? new Error('Failed to read app data backup.'));
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to read app data.'));
  });
}
function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function isAppDataExpected(): boolean {
  return safeLocalStorageGet(APP_DATA_EXPECTED_KEY) !== null;
}

function markAppDataExpected(savedAt: string): void {
  localStorage.setItem(APP_DATA_EXPECTED_KEY, savedAt);
}

function markAppDataExpectedBestEffort(savedAt: string): void {
  try {
    markAppDataExpected(savedAt);
  } catch {
    // A later successful save will retry the durable marker.
  }
}

function isAppDataRecoveryRequired(): boolean {
  try {
    return localStorage.getItem(APP_DATA_RECOVERY_REQUIRED_KEY) !== null;
  } catch {
    // If this safety marker cannot be inspected, do not assume that the
    // current app snapshot is authoritative enough to overwrite a backup.
    return true;
  }
}

function markAppDataRecoveryRequiredBestEffort(reason: 'missing-primary' | 'backup-only'): void {
  try {
    localStorage.setItem(APP_DATA_RECOVERY_REQUIRED_KEY, JSON.stringify({ version: 1, reason }));
  } catch {
    // Existing sync history/expected markers still keep strict exports closed.
  }
}

function getLocalFallbackRecord(): { raw: string | null; savedAt: string | null } {
  const atomicRecordRaw = safeLocalStorageGet(APP_DATA_FALLBACK_RECORD_KEY);
  const atomicRecord = parseFallbackRecord(atomicRecordRaw);
  const legacyRaw = safeLocalStorageGet(APP_DATA_STORAGE_KEY);
  const legacySavedAt = safeLocalStorageGet(APP_DATA_FALLBACK_META_KEY);
  if (!atomicRecord) {
    return legacyRaw !== null
      ? { raw: legacyRaw, savedAt: legacySavedAt }
      : { raw: atomicRecordRaw, savedAt: null };
  }
  if (!tryParseAppDataRaw(legacyRaw)) return atomicRecord;

  const preferredRaw = pickPreferredAppDataRaw(
    atomicRecord.raw,
    atomicRecord.savedAt,
    legacyRaw,
    legacySavedAt,
  );
  return preferredRaw === legacyRaw
    ? { raw: legacyRaw, savedAt: legacySavedAt }
    : atomicRecord;
}

function parseFallbackRecord(value: string | null): { raw: string; savedAt: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed)
      || typeof parsed.raw !== 'string'
      || typeof parsed.savedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.savedAt))
      || !tryParseAppDataRaw(parsed.raw)
    ) {
      return null;
    }
    return { raw: parsed.raw, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

function safeLocalStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort cleanup only.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
