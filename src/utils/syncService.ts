import {
  APP_DATA_FALLBACK_META_KEY,
  APP_DATA_EXPECTED_KEY,
  APP_DATA_RECOVERY_REQUIRED_KEY,
  APP_DATA_STORAGE_KEY,
  exportAppDataRaw,
  importAppDataRaw,
  isAppData,
  waitForPendingAppDataSaves,
} from '../storage';
import {
  exportCategoryNotesRaw,
  CATEGORY_NOTES_MANIFEST_KEY,
  CATEGORY_NOTES_RECOVERY_REQUIRED_KEY,
  isCategoryNoteKey,
  isValidCategoryNoteRaw,
  replaceCategoryNotesRaw,
  waitForPendingCategoryNoteSaves,
} from './noteStorage';
import {
  clearSyncStateForChangedId,
  isStrongSyncId,
  LAST_REMOTE_UPDATED_AT_KEY,
  LAST_SYNC_AT_KEY,
  LAST_SYNC_ERROR_KEY,
  LAST_SYNC_OWNER_KEY,
  LAST_SYNC_RECORD_KEY,
  LAST_SYNC_STATUS_KEY,
  LAST_UPLOAD_HASH_KEY,
} from './syncState';
import {
  associateLocalDataRevision,
  getAssociatedLocalDataRevision,
  getLocalDataRevision,
} from './localDataRevision';
import {
  assertDataEpochSnapshotCurrent,
  associateDataEpochSnapshot,
  withCoordinatedDataMutation,
  withCoordinatedDataRead,
} from './dataCoordination';
import type { CloudAccessTokenResult } from './cloudService';
import { saveBackupPayload } from './backupRepository';
export type SyncPayload = {
  version: 1;
  updatedAt: string;
  localStorage: Record<string, string>;
  indexedDbNotes?: Record<string, string>;
};

export type SyncErrorCode =
  | 'authentication_required'
  | 'connection_changed'
  | 'conflict'
  | 'deleted'
  | 'invalid'
  | 'local_changed'
  | 'not_found'
  | 'payload_too_large'
  | 'quota'
  | 'rate_limited';

export type SyncResult<T> = { ok: true; value: T } | {
  ok: false;
  error: string;
  code?: SyncErrorCode;
  remoteUpdatedAt?: string;
};

export type RemoteSyncRecord = {
  syncId: string;
  payload: SyncPayload;
  updatedAt: string;
  localChangesPending?: boolean;
};

export type RemoteSyncMeta = {
  syncId: string;
  updatedAt: string;
};

export type SyncPairingCode = {
  code: string;
  expiresAt: string;
};

export type LegacySyncUpgrade = {
  syncId: string;
  updatedAt: string;
  requiresConnectionConfirmation?: boolean;
};

export type UploadSyncOptions = {
  expectedRemoteUpdatedAt?: string | null;
  force?: boolean;
};

export type SyncPayloadSummary = {
  keyCount: number;
  byteSize: number;
  folderCount: number;
  problemSetCount: number;
  questionCount: number;
  progressCount: number;
  noteCount: number;
};

export type AutoSyncSettings = {
  enabled: boolean;
  syncId: string;
  configured: boolean;
};

export type LastSyncState = {
  lastSyncAt: string;
  lastUploadHash: string;
  lastRemoteUpdatedAt: string;
  status: string;
  error: string;
};

export type SyncDiagnosticStep = {
  name: string;
  ok: boolean;
  message?: string;
  errorCode?: string;
  errorDetails?: string;
  errorHint?: string;
  suggestion?: string;
};

export type SyncDiagnosticResult = {
  ok: boolean;
  steps: SyncDiagnosticStep[];
};

export type SyncEnvironmentStatus = {
  hasUrl: boolean;
  hasAnonKey: boolean;
  configured: boolean;
  urlHost: string;
};

export const SYNC_ID_STORAGE_KEY = 'quizMake:sync:id';
const AUTO_SYNC_ENABLED_KEY = 'quizMake:sync:autoEnabled';
export const SYNC_BACKUP_PREFIX = 'quizMake:sync:backup:';
export const MAX_SYNC_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_SYNC_STORAGE_KEYS = 10_000;
const SUPABASE_READ_RPC = 'quiz_sync_read';
const SUPABASE_META_RPC = 'quiz_sync_meta';
const SUPABASE_UPSERT_RPC = 'quiz_sync_upsert_v2';
const SUPABASE_PROBE_RPC = 'quiz_sync_probe';
const SUPABASE_DELETE_RPC = 'quiz_sync_delete_v2';
const SUPABASE_CREATE_PAIRING_RPC = 'quiz_sync_create_pairing_code';
const SUPABASE_REDEEM_PAIRING_RPC = 'quiz_sync_redeem_pairing_code';
const SUPABASE_UPGRADE_LEGACY_RPC = 'quiz_sync_upgrade_legacy_id';
const LEGACY_UPGRADE_PENDING_KEY = 'quizMake:sync:legacyUpgradePending';
const LEGACY_UPGRADE_COMPLETED_KEY = 'quizMake:sync:legacyUpgradeCompleted';
const DATA_IMPORT_IN_PROGRESS_KEY = 'quizMake:sync:dataImportInProgress';
const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
let syncDataOperationQueue: Promise<void> = Promise.resolve();
const recoveryOnlyPayloads = new WeakSet<object>();
type SyncAccessTokenProvider = () => Promise<CloudAccessTokenResult>;
const defaultSyncAccessTokenProvider: SyncAccessTokenProvider = async () => {
  const { getCloudAccessToken } = await import('./cloudService');
  return getCloudAccessToken();
};
let syncAccessTokenProvider: SyncAccessTokenProvider = defaultSyncAccessTokenProvider;

export function setSyncAccessTokenProviderForTests(provider: SyncAccessTokenProvider | null): void {
  if (!import.meta.env.DEV) throw new Error('同期認証のテスト用差し替えは開発ビルドでのみ利用できます。');
  syncAccessTokenProvider = provider ?? defaultSyncAccessTokenProvider;
}

export type PendingLegacySyncUpgrade = {
  legacySyncId: string;
  expectedUpdatedAt: string;
  candidateSyncId: string;
};

type CompletedLegacySyncUpgrade = {
  syncId: string;
  updatedAt: string;
};

export function isSyncConfigured(): boolean {
  return Boolean(getRemoteSyncConfig());
}

export function getSyncEnvironmentStatus(): SyncEnvironmentStatus {
  const env = import.meta.env as Record<string, string | undefined>;
  const rawUrl = env.VITE_SUPABASE_URL ?? env.VITE_QUIZ_SYNC_SUPABASE_URL ?? '';
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.VITE_QUIZ_SYNC_SUPABASE_ANON_KEY ?? '';
  let urlHost = '';

  try {
    urlHost = rawUrl ? new URL(rawUrl).host : '';
  } catch {
    urlHost = 'URL形式が不正です';
  }

  return {
    hasUrl: Boolean(rawUrl),
    hasAnonKey: Boolean(anonKey),
    configured: Boolean(rawUrl && anonKey),
    urlHost,
  };
}

export function getRemoteSyncConfig(): { url: string; anonKey: string } | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const url = env.VITE_SUPABASE_URL ?? env.VITE_QUIZ_SYNC_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.VITE_QUIZ_SYNC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ''), anonKey };
}


export function clearSyncLocalBackups(): number {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(SYNC_BACKUP_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
    return keys.length;
  } catch {
    return 0;
  }
}

export function cleanupLegacySyncBackups(): void {
  clearSyncLocalBackups();
}

export function getStoredSyncId(): string {
  return safeGetItem(SYNC_ID_STORAGE_KEY);
}

export function setStoredSyncId(syncId: string): SyncResult<string> {
  const value = syncId.trim();
  let previousRaw: string | null | undefined;
  let previousState: Map<string, string | null> | null = null;
  try {
    previousRaw = localStorage.getItem(SYNC_ID_STORAGE_KEY);
    const previousValue = previousRaw?.trim() ?? '';
    previousState = captureSyncStateStorage();

    // Persist and verify the new owner before clearing the old owner's state.
    // A failed or silently ignored ID write must leave every CAS/hash field for
    // the still-active connection intact.
    if (value) localStorage.setItem(SYNC_ID_STORAGE_KEY, value);
    else localStorage.removeItem(SYNC_ID_STORAGE_KEY);

    const persisted = localStorage.getItem(SYNC_ID_STORAGE_KEY);
    const expected = value || null;
    if (persisted !== expected) {
      // A few restricted/custom storage implementations silently ignore a
      // write. Restore the previous value when possible, then report failure.
      try {
        if (previousRaw === null) localStorage.removeItem(SYNC_ID_STORAGE_KEY);
        else localStorage.setItem(SYNC_ID_STORAGE_KEY, previousRaw);
      } catch {
        // The verified result below remains a failure; no UI may claim success.
      }
      return { ok: false, error: '同期IDを端末に保存できませんでした。端末の保存設定と空き容量を確認してください。' };
    }

    const connectionChanged = clearSyncStateForChangedId(localStorage, previousValue, value);
    if (connectionChanged) dispatchSyncStateChanged();
    dispatchSyncSettingsChanged();
    return { ok: true, value };
  } catch (error) {
    // Clearing the prior state can involve several storage keys. If any step
    // fails, restore both the old connection and its exact state best-effort so
    // a partial cleanup cannot weaken the next conflict check.
    if (previousRaw !== undefined) {
      try {
        if (previousRaw === null) localStorage.removeItem(SYNC_ID_STORAGE_KEY);
        else localStorage.setItem(SYNC_ID_STORAGE_KEY, previousRaw);
        if (previousState) restoreSyncStateStorage(previousState);
      } catch {
        // The operation still reports failure; callers must not update the UI.
      }
    }
    return {
      ok: false,
      error: error instanceof Error
        ? `同期IDを端末に保存できませんでした: ${error.message}`
        : '同期IDを端末に保存できませんでした。端末の保存設定と空き容量を確認してください。',
    };
  }
}

const SYNC_STATE_STORAGE_KEYS = [
  LAST_SYNC_AT_KEY,
  LAST_UPLOAD_HASH_KEY,
  LAST_REMOTE_UPDATED_AT_KEY,
  LAST_SYNC_STATUS_KEY,
  LAST_SYNC_ERROR_KEY,
  LAST_SYNC_OWNER_KEY,
  LAST_SYNC_RECORD_KEY,
] as const;

function captureSyncStateStorage(): Map<string, string | null> {
  return new Map(SYNC_STATE_STORAGE_KEYS.map((key) => [key, localStorage.getItem(key)]));
}

function restoreSyncStateStorage(snapshot: ReadonlyMap<string, string | null>): void {
  for (const [key, storedValue] of snapshot) {
    if (storedValue === null) localStorage.removeItem(key);
    else localStorage.setItem(key, storedValue);
  }
}

export function getAutoSyncSettings(): AutoSyncSettings {
  return {
    enabled: safeGetItem(AUTO_SYNC_ENABLED_KEY) === 'true',
    syncId: getStoredSyncId(),
    configured: isSyncConfigured(),
  };
}

export function setAutoSyncEnabled(enabled: boolean): SyncResult<boolean> {
  const syncId = getStoredSyncId().trim();
  if (enabled && !syncId) return { ok: false, error: '同期IDを入力してください。' };
  if (enabled && !isStrongSyncId(syncId)) return { ok: false, error: '同期IDは「同期IDを生成」で作成した36文字のIDを使用してください。' };
  if (enabled && !isSyncConfigured()) return { ok: false, error: 'Supabaseの環境変数が未設定です。' };

  try {
    const storedValue = enabled ? 'true' : 'false';
    localStorage.setItem(AUTO_SYNC_ENABLED_KEY, storedValue);
    if (localStorage.getItem(AUTO_SYNC_ENABLED_KEY) !== storedValue) {
      return { ok: false, error: '自動同期設定を端末に保存できませんでした。端末の保存設定と空き容量を確認してください。' };
    }
    setLastSyncState({ status: enabled ? '自動同期ON' : '自動同期OFF', error: '' });
    dispatchSyncSettingsChanged();
    return { ok: true, value: enabled };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自動同期設定の保存に失敗しました。' };
  }
}

export function getLastSyncState(): LastSyncState {
  const atomicRecord = readLastSyncStateRecord();
  if (atomicRecord) {
    return atomicRecord.owner === getStoredSyncId().trim()
      ? atomicRecord.state
      : emptyLastSyncState();
  }
  const owner = safeGetItem(LAST_SYNC_OWNER_KEY).trim();
  if (owner && owner !== getStoredSyncId().trim()) return emptyLastSyncState();
  return {
    lastSyncAt: safeGetItem(LAST_SYNC_AT_KEY),
    lastUploadHash: safeGetItem(LAST_UPLOAD_HASH_KEY),
    lastRemoteUpdatedAt: safeGetItem(LAST_REMOTE_UPDATED_AT_KEY),
    status: safeGetItem(LAST_SYNC_STATUS_KEY),
    error: safeGetItem(LAST_SYNC_ERROR_KEY),
  };
}

export function setLastSyncState(state: Partial<LastSyncState>): void {
  try {
    const owner = getStoredSyncId().trim();
    const nextState = { ...getLastSyncState(), ...state };
    writeLastSyncStateRecord(owner, nextState);
    writeLegacyLastSyncStateBestEffort(owner, nextState);
    window.dispatchEvent(new CustomEvent('quiz-make-sync-state-change'));
  } catch {
    // Status is informational only.
  }
}

export function generateSyncId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('安全な乱数生成機能を利用できません。');
  }
  const bytes = new Uint8Array(18);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/gu, '');
}

export function isValidPairingCode(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{8}$/u.test(normalizePairingCode(value));
}

async function waitForLocalPersistence(): Promise<SyncResult<number>> {
  try {
    const [appDataSaved] = await Promise.all([
      waitForPendingAppDataSaves(),
      waitForPendingCategoryNoteSaves(),
    ]);
    if (!appDataSaved) {
      return { ok: false, error: '端末内の問題データを保存できていないため、クラウド同期を中止しました。' };
    }
    return { ok: true, value: getLocalDataRevision() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? `端末内のノートを保存できていないため、クラウド同期を中止しました: ${error.message}`
        : '端末内のノートを保存できていないため、クラウド同期を中止しました。',
    };
  }
}

export function setLastSyncStateForConnection(
  syncId: string,
  state: Partial<LastSyncState>,
): boolean {
  const expectedSyncId = syncId.trim();
  if (!expectedSyncId || !isCurrentSyncConnection(expectedSyncId)) return false;
  try {
    const nextState = { ...getLastSyncState(), ...state };
    writeLastSyncStateRecord(expectedSyncId, nextState);
    writeLegacyLastSyncStateBestEffort(expectedSyncId, nextState);
    if (!isCurrentSyncConnection(expectedSyncId)) {
      clearLastSyncStateOwnedBy(expectedSyncId);
      return false;
    }
    window.dispatchEvent(new CustomEvent('quiz-make-sync-state-change'));
    return true;
  } catch {
    clearLastSyncStateOwnedBy(expectedSyncId);
    return false;
  }
}

export function exportQuizMakeData(
  updatedAt = new Date().toISOString(),
  options: { mode?: 'authoritative' | 'recovery' } = {},
): Promise<SyncPayload> {
  return runSyncDataOperation(async () => {
    if (options.mode !== 'recovery' && isDataImportInProgress()) {
      throw new Error('前回のデータ読込が完了したことを確認できないため、クラウドへの保存を中止しました。先にクラウドまたはJSONバックアップから読み込み直してください。');
    }
    const beforeSnapshot = await waitForLocalPersistence();
    if (!beforeSnapshot.ok) throw new Error(beforeSnapshot.error);
    return withCoordinatedDataRead(['app', 'notes'], async () => {
      if (options.mode !== 'recovery' && isDataImportInProgress()) {
        throw new Error('前回のデータ読込が完了したことを確認できないため、クラウドへの保存を中止しました。先にクラウドまたはJSONバックアップから読み込み直してください。');
      }
      const localStorageData: Record<string, string> = {};
      const keys: string[] = [];

      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && isQuizMakeStorageKey(key) && key !== APP_DATA_STORAGE_KEY && !isCategoryNoteKey(key)) keys.push(key);
      }

      keys.sort().forEach((key) => {
        const value = localStorage.getItem(key);
        if (value !== null) localStorageData[key] = value;
      });

      localStorageData[APP_DATA_STORAGE_KEY] = await exportAppDataRaw({
        coordinationLockHeld: true,
        mode: options.mode,
      });

      const payload: SyncPayload = {
        version: 1,
        updatedAt,
        localStorage: localStorageData,
        indexedDbNotes: await exportCategoryNotesRaw({
          coordinationLockHeld: true,
          mode: options.mode,
        }),
      };
      const result = associateLocalDataRevision(
        associateDataEpochSnapshot(payload, ['app', 'notes']),
        beforeSnapshot.value,
      );
      if (options.mode === 'recovery') recoveryOnlyPayloads.add(result);
      return result;
    }, { requireCrossContext: true });
  });
}

export function exportQuizMakeRecoveryData(updatedAt = new Date().toISOString()): Promise<SyncPayload> {
  return exportQuizMakeData(updatedAt, { mode: 'recovery' });
}

export function importQuizMakeData(
  payload: SyncPayload,
  options: { expectedSyncId?: string; authoritativeUpdatedAt?: string; expectedLocalHash?: string } = {},
): Promise<SyncResult<number>> {
  return runSyncDataOperation(async () => {
    const expectedSyncId = options.expectedSyncId?.trim();
    if (expectedSyncId && !isCurrentSyncConnection(expectedSyncId)) return syncConnectionChangedResult();
    try {
      const [appDataSaved] = await Promise.all([
        waitForPendingAppDataSaves(),
        waitForPendingCategoryNoteSaves(),
      ]);
      if (!appDataSaved) {
        return { ok: false, error: '端末内に未保存の変更があるため、クラウドからの読み込みを中止しました。' };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? `ノートを保存できないため、クラウドからの読み込みを中止しました: ${error.message}`
          : 'ノートを保存できないため、クラウドからの読み込みを中止しました。',
      };
    }
    try {
      return await withCoordinatedDataMutation(
        ['app', 'notes'],
        () => importQuizMakeDataUnlocked(payload, expectedSyncId, options.authoritativeUpdatedAt, options.expectedLocalHash),
        { requireCrossContext: true },
      );
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error && error.name === 'ExternalDataChangeError' ? 'local_changed' : undefined,
        error: error instanceof Error
          ? error.message
          : '別のタブとの保存調整に失敗したため、クラウドからの読み込みを中止しました。',
      };
    }
  });
}

async function importQuizMakeDataUnlocked(
  payload: SyncPayload,
  expectedSyncId?: string,
  authoritativeUpdatedAt?: string,
  expectedLocalHash?: string,
): Promise<SyncResult<number>> {
  const validation = validateSyncPayload(payload);
  if (!validation.ok) return validation;

  let previousAppDataRaw: string;
  let previousNotes: Record<string, string>;
  let previousLocalStorage: Record<string, string>;
  let previousIntegrity: DataIntegritySnapshot;
  try {
    previousAppDataRaw = await exportAppDataRaw({ coordinationLockHeld: true, mode: 'recovery' });
    previousNotes = await exportCategoryNotesRaw({ coordinationLockHeld: true, mode: 'recovery' });
    previousIntegrity = captureDataIntegritySnapshot();
    previousLocalStorage = collectCurrentQuizMakeLocalStorage();
    if (expectedLocalHash && computePayloadHash({version:1, updatedAt:'', localStorage:{...previousLocalStorage,[APP_DATA_STORAGE_KEY]:previousAppDataRaw}, indexedDbNotes:previousNotes}) !== expectedLocalHash) {
      return { ok: false, code: 'local_changed', error: '確認中に端末データが更新されました。内容を確認し直してください。' };
    }
    await saveBackupPayload({ version: 1, updatedAt: new Date().toISOString(), localStorage: { ...previousLocalStorage, [APP_DATA_STORAGE_KEY]: previousAppDataRaw }, indexedDbNotes: previousNotes }, expectedSyncId ? 'before-sync' : 'before-import');
    localStorage.setItem(DATA_IMPORT_IN_PROGRESS_KEY, JSON.stringify({ version: 1, startedAt: new Date().toISOString() }));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? `現在のデータを退避できないため、読み込みを中止しました: ${error.message}`
        : '現在のデータを退避できないため、読み込みを中止しました。',
    };
  }

  try {
    assertExpectedSyncConnection(expectedSyncId);
    const noteEntries: Record<string, string> = { ...(validation.value.indexedDbNotes ?? {}) };
    const nextLocalStorage: Record<string, string> = {};
    Object.entries(validation.value.localStorage).forEach(([key, value]) => {
      if (key === APP_DATA_STORAGE_KEY) return;
      if (isCategoryNoteKey(key)) {
        noteEntries[key] = value;
        return;
      }
      if (isQuizMakeStorageKey(key)) nextLocalStorage[key] = value;
    });

    const appDataRaw = validation.value.localStorage[APP_DATA_STORAGE_KEY] as string;
    const importedAppData = await importAppDataRaw(appDataRaw, {
      coordinationLockHeld: true,
      establishAuthority: true,
    });
    if (!importedAppData) {
      throw new Error('同期データの問題データを保存できませんでした。');
    }
    assertExpectedSyncConnection(expectedSyncId);

    const noteCount = await replaceCategoryNotesRaw(noteEntries, {
      coordinationLockHeld: true,
      establishAuthority: true,
    });
    assertExpectedSyncConnection(expectedSyncId);
    replaceQuizMakeLocalStorage(nextLocalStorage);
    assertExpectedSyncConnection(expectedSyncId);

    if (expectedSyncId) {
      if (!authoritativeUpdatedAt || !Number.isFinite(Date.parse(authoritativeUpdatedAt))) {
        throw new Error('クラウド側の更新時刻を確認できないため、読み込みを中止しました。');
      }
    } else {
      setLastSyncState({
        lastSyncAt: '',
        lastRemoteUpdatedAt: '',
        lastUploadHash: '',
        status: 'バックアップを読み込みました。クラウド同期は再確認が必要です',
        error: '',
      });
    }

    localStorage.removeItem(DATA_IMPORT_IN_PROGRESS_KEY);

    const localStorageCount = Object.keys(validation.value.localStorage).filter((key) => !isCategoryNoteKey(key)).length;
    return { ok: true, value: localStorageCount + noteCount };
  } catch (error) {
    const rollback = await restoreImportedData(
      previousAppDataRaw,
      previousNotes,
      previousLocalStorage,
      previousIntegrity,
      true,
    );
    const connectionChanged = error instanceof SyncConnectionChangedDuringImportError;
    const rollbackSuffix = rollback.ok
      ? '既存データへ戻しました。'
      : `既存データの復元にも失敗しました: ${rollback.error}`;
    return {
      ok: false,
      code: connectionChanged ? 'connection_changed' : undefined,
      error: isQuotaExceededError(error)
        ? `端末内の保存容量がいっぱいです。同期バックアップを整理するか、不要なノートデータを減らしてください。${rollbackSuffix}`
        : error instanceof Error
          ? `同期データの読み込みに失敗しました: ${error.message} ${rollbackSuffix}`
          : `同期データの読み込みに失敗しました。${rollbackSuffix}`,
    };
  }
}
export async function uploadSyncData(
  syncId: string,
  payload: SyncPayload,
  options: UploadSyncOptions = {},
): Promise<SyncResult<RemoteSyncRecord>> {
  if (recoveryOnlyPayloads.has(payload)) {
    return {
      ok: false,
      code: 'invalid',
      error: '復旧用に書き出した未確認データは、そのままクラウドへ保存できません。内容を確認して読み込み直してから同期してください。',
    };
  }
  return runSyncDataOperation(async () => {
    const normalizedSyncId = syncId.trim();
    if (!normalizedSyncId) return { ok: false, error: '同期IDを入力してください。' };
    if (!isStrongSyncId(normalizedSyncId)) {
      return { ok: false, error: '同期IDは「同期IDを生成」で作成した36文字のIDを使用してください。' };
    }
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

    const config = getRemoteSyncConfig();
    if (!config) {
      return { ok: false, error: 'Supabaseの環境変数が未設定です。VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください。' };
    }

    const validation = validateSyncPayload(payload);
    if (!validation.ok) return validation;

    const exportedRevision = getAssociatedLocalDataRevision(payload);
    if (exportedRevision === undefined) {
      return {
        ok: false,
        code: 'local_changed',
        error: '送信元の端末データを安全に確認できないため、クラウド保存を中止しました。最新の内容を読み直してからもう一度お試しください。',
      };
    }

    const beforeUpload = await waitForLocalPersistence();
    if (!beforeUpload.ok) return beforeUpload;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (exportedRevision !== beforeUpload.value) return localDataChangedBeforeUploadResult();

    const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
    if (!authenticatedHeaders.ok) return authenticatedHeaders;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

    try {
      const uploaded = await withCoordinatedDataRead(['app', 'notes'], async () => {
        if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
        assertDataEpochSnapshotCurrent(payload, ['app', 'notes']);
        if (getLocalDataRevision() !== beforeUpload.value) return localDataChangedBeforeUploadResult();
        return uploadSyncDataUnlocked(
          normalizedSyncId,
          validation.value,
          options,
          config,
          authenticatedHeaders.value,
          beforeUpload.value,
        );
      }, { requireCrossContext: true });
      if (!uploaded.ok) return uploaded;

      const afterUpload = await waitForLocalPersistence();
      let localChangesPending = !afterUpload.ok || afterUpload.value !== beforeUpload.value;
      try {
        assertDataEpochSnapshotCurrent(payload, ['app', 'notes']);
      } catch {
        localChangesPending = true;
      }
      if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
      const uploadPayload = { ...validation.value, updatedAt: uploaded.value.payload.updatedAt };
      if (!setLastSyncStateForConnection(normalizedSyncId, {
        lastSyncAt: uploaded.value.updatedAt,
        lastUploadHash: localChangesPending ? '' : computePayloadHash(uploadPayload),
        lastRemoteUpdatedAt: uploaded.value.updatedAt,
        status: localChangesPending
          ? 'クラウド保存中に端末データが更新されました。最新の内容を再同期します'
          : 'クラウドへ保存しました',
        error: afterUpload.ok ? '' : afterUpload.error,
      })) return syncConnectionChangedResult();
      return localChangesPending
        ? { ok: true, value: { ...uploaded.value, localChangesPending: true } }
        : uploaded;
    } catch (error) {
      if (error instanceof Error && error.name === 'ExternalDataChangeError') {
        return localDataChangedBeforeUploadResult();
      }
      return {
        ok: false,
        error: error instanceof Error
          ? `別のタブとの保存調整に失敗したため、クラウド保存を中止しました: ${error.message}`
          : '別のタブとの保存調整に失敗したため、クラウド保存を中止しました。',
      };
    }
  });
}

async function uploadSyncDataUnlocked(
  normalizedSyncId: string,
  payload: SyncPayload,
  options: UploadSyncOptions,
  config: { url: string; anonKey: string },
  authenticatedHeaders: Record<string, string>,
  uploadStartRevision: number,
): Promise<SyncResult<RemoteSyncRecord>> {
  try {
    const updatedAt = new Date().toISOString();
    const uploadPayload = { ...payload, updatedAt };
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_UPSERT_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders,
      body: JSON.stringify({
        p_sync_id: normalizedSyncId,
        p_data: uploadPayload,
        p_updated_at: updatedAt,
        p_expected_updated_at: options.expectedRemoteUpdatedAt ?? null,
        p_force: options.force ?? false,
      }),
    });
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

    if (!response.ok && await isMissingSyncRpc(response)) {
      return { ok: false, error: '安全な同期RPCが見つかりません。Supabaseへ最新の同期マイグレーションを適用してください。' };
    }

    if (!response.ok) {
      const details = await readSupabaseError(response);
      const isConflict = details.code === '40001' || details.message.includes('quiz_sync_conflict');
      if (response.status === 429) {
        return { ok: false, code: 'rate_limited', error: '操作回数が多すぎます。1分ほど待ってからもう一度お試しください。' };
      }
      if (response.status === 413) {
        return { ok: false, code: 'payload_too_large', error: '同期データが大きすぎます（上限8 MB）。大きなノート画像を整理してから再試行してください。' };
      }
      return {
        ok: false,
        code: isConflict ? 'conflict' : undefined,
        error: isConflict
          ? 'クラウド側に、この端末が最後に確認したものより新しいデータがあります。先にクラウドから読み込んでください。'
          : `クラウドへの保存に失敗しました。${details.message ? ` ${details.message}` : ''}`,
      };
    }

    const rows = (await response.json()) as unknown;
    const first = Array.isArray(rows) ? rows[0] : null;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    const rpcFailure = syncRpcFailureFromRow(first, 'upload');
    if (rpcFailure) return rpcFailure;
    const record = parseRemoteRecord(first, normalizedSyncId, true);
    if (!record.ok) return record;
    if (computePayloadHash(record.value.payload) !== computePayloadHash(uploadPayload)) {
      return { ok: false, error: 'クラウド保存結果の内容が送信したデータと一致しません。保存状態を確認してから再試行してください。' };
    }
    if (getLocalDataRevision() !== uploadStartRevision) {
      return { ok: true, value: { ...record.value, localChangesPending: true } };
    }
    return record;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `クラウドへの保存に失敗しました: ${error.message}` : 'クラウドへの保存に失敗しました。',
    };
  }
}

export async function downloadSyncData(syncId: string): Promise<SyncResult<RemoteSyncRecord | null>> {
  const normalizedSyncId = syncId.trim();
  if (!normalizedSyncId) return { ok: false, error: '同期IDを入力してください。' };
  if (!isStrongSyncId(normalizedSyncId)) return { ok: false, error: '同期IDは「同期IDを生成」で作成した36文字のIDを使用してください。' };
  if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

  const config = getRemoteSyncConfig();
  if (!config) return { ok: false, error: 'Supabaseの環境変数が未設定です。VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください。' };

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  if (!authenticatedHeaders.ok) return authenticatedHeaders;
  if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

  try {
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_READ_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({ p_sync_id: normalizedSyncId }),
    });
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

    if (!response.ok && await isMissingSyncRpc(response)) return { ok: false, error: '安全な同期RPCが見つかりません。Supabaseへ最新の同期マイグレーションを適用してください。' };

    if (!response.ok) return { ok: false, error: await responseError(response, 'クラウドからの読み込みに失敗しました。') };

    const rows = (await response.json()) as unknown;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (!Array.isArray(rows) || rows.length === 0) return { ok: true, value: null };

    const record = parseRemoteRecord(rows[0], normalizedSyncId);
    if (!record.ok) return record;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (!setLastSyncStateForConnection(normalizedSyncId, { lastRemoteUpdatedAt: record.value.updatedAt })) {
      return syncConnectionChangedResult();
    }
    return record;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `クラウドからの読み込みに失敗しました: ${error.message}` : 'クラウドからの読み込みに失敗しました。',
    };
  }
}

export async function getRemoteSyncMeta(syncId: string): Promise<SyncResult<RemoteSyncMeta | null>> {
  const normalizedSyncId = syncId.trim();
  if (!normalizedSyncId) return { ok: false, error: '同期IDを入力してください。' };
  if (!isStrongSyncId(normalizedSyncId)) return { ok: false, error: '同期IDは「同期IDを生成」で作成した36文字のIDを使用してください。' };

  const config = getRemoteSyncConfig();
  if (!config) return { ok: false, error: 'Supabaseの環境変数が未設定です。' };

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  if (!authenticatedHeaders.ok) return authenticatedHeaders;

  try {
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_META_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({ p_sync_id: normalizedSyncId }),
    });

    if (!response.ok && await isMissingSyncRpc(response)) return { ok: false, error: '安全な同期RPCが見つかりません。Supabaseへ最新の同期マイグレーションを適用してください。' };

    if (!response.ok) return { ok: false, error: await responseError(response, 'クラウドの更新確認に失敗しました。') };
    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return { ok: true, value: null };
    const row = rows[0];
    if (
      !isRecord(row)
      || row.sync_id !== normalizedSyncId
      || typeof row.updated_at !== 'string'
      || !Number.isFinite(Date.parse(row.updated_at))
    ) {
      return { ok: false, error: 'クラウドの更新情報の形式が正しくありません。' };
    }
    return { ok: true, value: { syncId: normalizedSyncId, updatedAt: row.updated_at } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `クラウドの更新確認に失敗しました: ${error.message}` : 'クラウドの更新確認に失敗しました。',
    };
  }
}


export async function runSyncDiagnostic(syncId: string): Promise<SyncDiagnosticResult> {
  const steps: SyncDiagnosticStep[] = [];
  const envStatus = getSyncEnvironmentStatus();
  const normalizedSyncId = syncId.trim();

  const addStep = (step: SyncDiagnosticStep) => steps.push(step);

  addStep({
    name: 'Supabase URL',
    ok: envStatus.hasUrl,
    message: envStatus.hasUrl ? `設定済み${envStatus.urlHost ? ` (${envStatus.urlHost})` : ''}` : '未設定',
  });
  addStep({ name: 'anon key', ok: envStatus.hasAnonKey, message: envStatus.hasAnonKey ? '設定済み' : '未設定' });
  addStep({
    name: '同期ID',
    ok: isStrongSyncId(normalizedSyncId),
    message: !normalizedSyncId
      ? '未入力'
      : isStrongSyncId(normalizedSyncId)
        ? '安全な36文字IDです'
        : '「同期IDを生成」で作成した36文字のIDを使用してください',
  });

  let exportedPayload: SyncPayload | null = null;
  try {
    exportedPayload = await exportQuizMakeData();
    addStep({ name: 'localStorage export', ok: true, message: `${Object.keys(exportedPayload.localStorage).length}件のキーをexportできます` });
  } catch (error) {
    addStep({
      name: 'localStorage export',
      ok: false,
      message: '端末データのexportに失敗しました',
      errorDetails: error instanceof Error ? error.message : String(error),
    });
  }

  const config = getRemoteSyncConfig();
  if (!config || !isStrongSyncId(normalizedSyncId) || !exportedPayload) {
    addStep({
      name: 'テーブル接続',
      ok: false,
      message: 'Supabase設定、同期ID、またはexport結果が不足しているため中止しました',
    });
    return { ok: steps.every((step) => step.ok), steps };
  }

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  addStep({
    name: 'ログイン',
    ok: authenticatedHeaders.ok,
    message: authenticatedHeaders.ok ? 'ログイン済みアカウントを確認しました' : authenticatedHeaders.error,
  });
  if (!authenticatedHeaders.ok) return { ok: false, steps };

  try {
    const probeResponse = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_PROBE_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({ p_sync_id: normalizedSyncId }),
    });
    addStep(await responseToDiagnosticStep(probeResponse, '安全な同期RPC', '同期IDを限定したRPCへ接続できます'));
    if (!probeResponse.ok) return { ok: false, steps };
  } catch (error) {
    addStep(exceptionToDiagnosticStep('安全な同期RPC', error));
    return { ok: false, steps };
  }

  try {
    const readResult = await downloadSyncData(normalizedSyncId);
    addStep(readResult.ok
      ? {
          name: '同期ID限定の読み込み',
          ok: true,
          message: readResult.value ? 'この同期IDのデータを読み込めます' : '接続できました（この同期IDのデータはまだありません）',
        }
      : {
          name: '同期ID限定の読み込み',
          ok: false,
          message: readResult.error,
          suggestion: getDiagnosticSuggestion(readResult.error),
        });
  } catch (error) {
    addStep(exceptionToDiagnosticStep('同期ID限定の読み込み', error));
  }

  return { ok: steps.every((step) => step.ok), steps };
}

export function computePayloadHash(payload: SyncPayload): string {
  const text = JSON.stringify({ version: payload.version, localStorage: sortRecord(payload.localStorage), indexedDbNotes: sortRecord(payload.indexedDbNotes ?? {}) });
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}


export function summarizeSyncPayload(payload: SyncPayload): SyncPayloadSummary {
  const appDataRaw = payload.localStorage[APP_DATA_STORAGE_KEY];
  let folderCount = 0;
  let problemSetCount = 0;
  let questionCount = 0;
  let progressCount = 0;

  if (appDataRaw) {
    try {
      const parsed = JSON.parse(appDataRaw) as Record<string, unknown>;
      folderCount = Array.isArray(parsed.folders) ? parsed.folders.length : 0;
      problemSetCount = Array.isArray(parsed.problemSets) ? parsed.problemSets.length : 0;
      questionCount = Array.isArray(parsed.questions) ? parsed.questions.length : 0;
      progressCount = Array.isArray(parsed.progress) ? parsed.progress.length : 0;
    } catch {
      // Summary only. Invalid app data is handled by the normal app loader/import path.
    }
  }

  const noteKeys = new Set([
    ...Object.keys(payload.localStorage).filter(isCategoryNoteKey),
    ...Object.keys(payload.indexedDbNotes ?? {}).filter(isCategoryNoteKey),
  ]);
  const noteCount = noteKeys.size;
  const text = JSON.stringify({ localStorage: payload.localStorage, indexedDbNotes: payload.indexedDbNotes ?? {} });
  const byteSize = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : text.length;

  return {
    keyCount: Object.keys(payload.localStorage).length,
    byteSize,
    folderCount,
    problemSetCount,
    questionCount,
    progressCount,
    noteCount,
  };
}

export function validateSyncPayload(value: unknown): SyncResult<SyncPayload> {
  if (!isRecord(value)) return { ok: false, error: '同期データの形式が正しくありません。' };
  const byteSize = measureJsonBytes(value);
  if (byteSize === null) return { ok: false, code: 'invalid', error: '同期データをJSONとして読み込めません。' };
  if (byteSize > MAX_SYNC_PAYLOAD_BYTES) {
    return {
      ok: false,
      code: 'payload_too_large',
      error: '同期データが大きすぎます（上限8 MB）。大きなノート画像を整理してから再試行してください。',
    };
  }
  if (value.version !== 1) return { ok: false, error: '同期データのversionに対応していません。' };
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    return { ok: false, error: '同期データのupdatedAtが正しくありません。' };
  }
  if (!isStringRecord(value.localStorage)) return { ok: false, error: '同期データのlocalStorage形式が正しくありません。' };

  const invalidKey = Object.keys(value.localStorage).find((key) => !isQuizMakeStorageKey(key));
  if (invalidKey) return { ok: false, error: 'Quiz make以外のキーが含まれています: ' + invalidKey };

  const indexedDbNotesValue = value.indexedDbNotes;
  if (indexedDbNotesValue !== undefined && !isStringRecord(indexedDbNotesValue)) {
    return { ok: false, error: '同期データのindexedDbNotes形式が正しくありません。' };
  }
  const indexedDbNotes = indexedDbNotesValue ?? {};
  const storageKeyCount = Object.keys(value.localStorage).length + Object.keys(indexedDbNotes).length;
  if (storageKeyCount > MAX_SYNC_STORAGE_KEYS) {
    return {
      ok: false,
      code: 'invalid',
      error: `同期データの項目数が多すぎます（上限 ${MAX_SYNC_STORAGE_KEYS.toLocaleString('ja-JP')}件）。`,
    };
  }
  const invalidNoteKey = Object.keys(indexedDbNotes).find((key) => !isCategoryNoteKey(key));
  if (invalidNoteKey) return { ok: false, error: 'ノート以外のキーが含まれています: ' + invalidNoteKey };
  const invalidIndexedNote = Object.entries(indexedDbNotes).find(([, raw]) => !isValidCategoryNoteRaw(raw));
  if (invalidIndexedNote) return { ok: false, error: `ノートデータの形式が正しくありません: ${invalidIndexedNote[0]}` };

  const invalidLegacyNote = Object.entries(value.localStorage)
    .find(([key, raw]) => isCategoryNoteKey(key) && !isValidCategoryNoteRaw(raw));
  if (invalidLegacyNote) return { ok: false, error: `ノートデータの形式が正しくありません: ${invalidLegacyNote[0]}` };

  const appDataRaw = value.localStorage[APP_DATA_STORAGE_KEY];
  if (appDataRaw === undefined) {
    return { ok: false, error: '同期データに問題データがありません。既存データは変更していません。' };
  }
  try {
    const appData = JSON.parse(appDataRaw) as unknown;
    if (!isAppData(appData)) {
      return { ok: false, error: '同期データの問題データ形式が正しくありません。既存データは変更していません。' };
    }
  } catch {
    return { ok: false, error: '同期データの問題データJSONを読み込めません。既存データは変更していません。' };
  }

  return {
    ok: true,
    value: {
      version: 1,
      updatedAt: value.updatedAt,
      localStorage: sortRecord(value.localStorage),
      indexedDbNotes: sortRecord(indexedDbNotes),
    },
  };
}

export async function deleteRemoteSyncData(
  syncId: string,
  expectedUpdatedAt: string,
  force = false,
): Promise<SyncResult<boolean>> {
  const normalizedSyncId = syncId.trim();
  if (!normalizedSyncId) return { ok: false, error: '同期IDを入力してください。' };
  if (!isStrongSyncId(normalizedSyncId)) return { ok: false, error: '同期IDは「同期IDを生成」で作成した36文字のIDを使用してください。' };
  if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return {
      ok: false,
      code: 'conflict',
      error: '削除前にクラウドの最新状態を確認してください。先に「クラウドから読込」を実行できます。',
    };
  }

  const config = getRemoteSyncConfig();
  if (!config) return { ok: false, error: 'クラウド同期が設定されていません。' };

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  if (!authenticatedHeaders.ok) return authenticatedHeaders;
  if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

  try {
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_DELETE_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({
        p_sync_id: normalizedSyncId,
        p_expected_updated_at: expectedUpdatedAt || null,
        p_force: force,
      }),
    });
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (!response.ok) return { ok: false, error: await responseError(response, 'クラウドデータの削除に失敗しました。') };
    const rows = await response.json() as unknown;
    const first = Array.isArray(rows) ? rows[0] : null;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (isRecord(first) && first.result_code === 'not_found') return { ok: true, value: false };
    const rpcFailure = syncRpcFailureFromRow(first, 'delete');
    if (rpcFailure) return rpcFailure;
    if (
      !isRecord(first)
      || first.result_code !== 'ok'
      || first.sync_id !== normalizedSyncId
      || typeof first.updated_at !== 'string'
      || !Number.isFinite(Date.parse(first.updated_at))
    ) {
      return { ok: false, error: 'クラウド削除結果の形式が正しくありません。' };
    }
    if (!setLastSyncStateForConnection(normalizedSyncId, {
      lastRemoteUpdatedAt: '',
      lastUploadHash: '',
      status: 'クラウドデータ削除済み',
      error: '',
    })) return syncConnectionChangedResult();
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    setAutoSyncEnabled(false);
    return { ok: true, value: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `クラウドデータの削除に失敗しました: ${error.message}` : 'クラウドデータの削除に失敗しました。',
    };
  }
}

function localDataChangedBeforeUploadResult(): SyncResult<never> {
  return {
    ok: false,
    code: 'local_changed',
    error: 'クラウドへの保存準備後に端末データが更新されたため、古い内容の送信を中止しました。最新の内容でもう一度保存します。',
  };
}

export async function createSyncPairingCode(syncId: string): Promise<SyncResult<SyncPairingCode>> {
  const normalizedSyncId = syncId.trim();
  if (!isStrongSyncId(normalizedSyncId)) {
    return { ok: false, code: 'invalid', error: '安全な同期接続がまだありません。先にこの端末をクラウドへ保存してください。' };
  }
  if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
  const config = getRemoteSyncConfig();
  if (!config) return { ok: false, error: 'クラウド同期が設定されていません。' };

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  if (!authenticatedHeaders.ok) return authenticatedHeaders;
  if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();

  try {
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_CREATE_PAIRING_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({ p_sync_id: normalizedSyncId }),
    });
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (!response.ok) return { ok: false, error: await syncRpcHttpError(response, '接続コードを発行できませんでした。') };
    const rows = await response.json() as unknown;
    const first = Array.isArray(rows) ? rows[0] : null;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    const rpcFailure = syncRpcFailureFromRow(first, 'pair_create');
    if (rpcFailure) return rpcFailure;
    if (!isCurrentSyncConnection(normalizedSyncId)) return syncConnectionChangedResult();
    if (
      !isRecord(first)
      || first.result_code !== 'ok'
      || typeof first.pairing_code !== 'string'
      || typeof first.expires_at !== 'string'
      || !isValidPairingCode(first.pairing_code)
      || !Number.isFinite(Date.parse(first.expires_at))
    ) {
      return { ok: false, error: '接続コードの形式が正しくありません。' };
    }
    return { ok: true, value: { code: normalizePairingCode(first.pairing_code), expiresAt: first.expires_at } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `接続コードを発行できませんでした: ${error.message}` : '接続コードを発行できませんでした。',
    };
  }
}

export async function redeemSyncPairingCode(pairingCode: string): Promise<SyncResult<string>> {
  const normalizedCode = normalizePairingCode(pairingCode);
  if (!isValidPairingCode(normalizedCode)) {
    return { ok: false, code: 'invalid', error: '接続コードは8文字で入力してください。' };
  }
  const config = getRemoteSyncConfig();
  if (!config) return { ok: false, error: 'クラウド同期が設定されていません。' };

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  if (!authenticatedHeaders.ok) return authenticatedHeaders;

  try {
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_REDEEM_PAIRING_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({ p_pairing_code: normalizedCode }),
    });
    if (!response.ok) return { ok: false, error: await syncRpcHttpError(response, '接続コードを確認できませんでした。') };
    const rows = await response.json() as unknown;
    const first = Array.isArray(rows) ? rows[0] : null;
    const rpcFailure = syncRpcFailureFromRow(first, 'pair_redeem');
    if (rpcFailure) return rpcFailure;
    if (!isRecord(first) || first.result_code !== 'ok' || typeof first.sync_id !== 'string' || !isStrongSyncId(first.sync_id)) {
      return { ok: false, error: '接続先の形式が正しくありません。' };
    }
    return { ok: true, value: first.sync_id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `接続コードを確認できませんでした: ${error.message}` : '接続コードを確認できませんでした。',
    };
  }
}

export async function upgradeLegacySyncId(
  legacySyncId: string,
  expectedUpdatedAt: string,
): Promise<SyncResult<LegacySyncUpgrade>> {
  const normalizedLegacyId = legacySyncId.trim();
  if (!normalizedLegacyId || isStrongSyncId(normalizedLegacyId) || normalizedLegacyId.length > 128) {
    return { ok: false, code: 'invalid', error: '旧同期IDの形式が正しくありません。' };
  }
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return { ok: false, code: 'conflict', error: '旧同期IDの更新情報が端末に残っていないため、自動移行できません。' };
  }
  if (!isCurrentSyncConnection(normalizedLegacyId)) return syncConnectionChangedResult();

  try {
    const pending = getOrCreatePendingLegacySyncUpgrade(normalizedLegacyId, expectedUpdatedAt);
    return await completePendingLegacySyncUpgrade(pending);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `旧同期IDを移行できませんでした: ${error.message}` : '旧同期IDを移行できませんでした。',
    };
  }
}

export function getPendingLegacySyncUpgrade(): PendingLegacySyncUpgrade | null {
  return readPendingLegacySyncUpgrade();
}

export async function resumePendingLegacySyncUpgrade(): Promise<SyncResult<LegacySyncUpgrade | null>> {
  const pending = readPendingLegacySyncUpgrade();
  if (!pending) return { ok: true, value: null };
  return completePendingLegacySyncUpgrade(pending);
}

export function getPendingLegacySyncCompletion(): CompletedLegacySyncUpgrade | null {
  try {
    const raw = localStorage.getItem(LEGACY_UPGRADE_COMPLETED_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value)
      || typeof value.syncId !== 'string'
      || !isStrongSyncId(value.syncId)
      || typeof value.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(value.updatedAt))
    ) {
      return null;
    }
    return {
      syncId: value.syncId,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
}

export function clearPendingLegacySyncCompletion(syncId: string): void {
  try {
    const completed = getPendingLegacySyncCompletion();
    if (completed?.syncId === syncId) localStorage.removeItem(LEGACY_UPGRADE_COMPLETED_KEY);
  } catch {
    // A stale completion marker is harmless and can be retried after reload.
  }
}

function persistPendingLegacySyncCompletion(completed: CompletedLegacySyncUpgrade): void {
  localStorage.setItem(LEGACY_UPGRADE_COMPLETED_KEY, JSON.stringify(completed));
  if (getPendingLegacySyncCompletion()?.syncId !== completed.syncId) {
    throw new Error('移行済みの接続先を端末へ保存できませんでした。');
  }
}

function getOrCreatePendingLegacySyncUpgrade(
  legacySyncId: string,
  expectedUpdatedAt: string,
): PendingLegacySyncUpgrade {
  const existing = readPendingLegacySyncUpgrade();
  if (
    existing
    && existing.legacySyncId === legacySyncId
    && existing.expectedUpdatedAt === expectedUpdatedAt
  ) {
    return existing;
  }

  const pending: PendingLegacySyncUpgrade = {
    legacySyncId,
    expectedUpdatedAt,
    candidateSyncId: generateSyncId(),
  };
  localStorage.setItem(LEGACY_UPGRADE_PENDING_KEY, JSON.stringify(pending));
  const persisted = readPendingLegacySyncUpgrade();
  if (!persisted || persisted.candidateSyncId !== pending.candidateSyncId) {
    throw new Error('安全な移行先を端末に保存できませんでした。');
  }
  return persisted;
}

function readPendingLegacySyncUpgrade(): PendingLegacySyncUpgrade | null {
  try {
    const raw = localStorage.getItem(LEGACY_UPGRADE_PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value)
      || typeof value.legacySyncId !== 'string'
      || typeof value.expectedUpdatedAt !== 'string'
      || typeof value.candidateSyncId !== 'string'
      || !isStrongSyncId(value.candidateSyncId)
    ) {
      return null;
    }
    return {
      legacySyncId: value.legacySyncId,
      expectedUpdatedAt: value.expectedUpdatedAt,
      candidateSyncId: value.candidateSyncId,
    };
  } catch {
    return null;
  }
}

function clearPendingLegacySyncUpgrade(completed: PendingLegacySyncUpgrade): void {
  try {
    const current = readPendingLegacySyncUpgrade();
    if (current?.candidateSyncId === completed.candidateSyncId) {
      localStorage.removeItem(LEGACY_UPGRADE_PENDING_KEY);
    }
  } catch {
    // The active sync ID is already durable; a stale retry marker is harmless.
  }
}

async function completePendingLegacySyncUpgrade(
  pending: PendingLegacySyncUpgrade,
): Promise<SyncResult<LegacySyncUpgrade>> {
  const config = getRemoteSyncConfig();
  if (!config) return { ok: false, error: 'クラウド同期が設定されていません。' };

  const authenticatedHeaders = await getAuthenticatedSyncHeaders(config);
  if (!authenticatedHeaders.ok) return authenticatedHeaders;

  try {
    const response = await fetchWithTimeout(`${config.url}/rest/v1/rpc/${SUPABASE_UPGRADE_LEGACY_RPC}`, {
      method: 'POST',
      headers: authenticatedHeaders.value,
      body: JSON.stringify({
        p_legacy_sync_id: pending.legacySyncId,
        p_expected_updated_at: pending.expectedUpdatedAt,
        p_candidate_sync_id: pending.candidateSyncId,
      }),
    });
    if (!response.ok) return { ok: false, error: await syncRpcHttpError(response, '旧同期IDを移行できませんでした。') };
    const rows = await response.json() as unknown;
    const first = Array.isArray(rows) ? rows[0] : null;
    const rpcFailure = syncRpcFailureFromRow(first, 'legacy_upgrade');
    if (rpcFailure) return rpcFailure;
    if (
      !isRecord(first)
      || first.result_code !== 'ok'
      || typeof first.sync_id !== 'string'
      || !isStrongSyncId(first.sync_id)
      || typeof first.updated_at !== 'string'
      || !Number.isFinite(Date.parse(first.updated_at))
    ) {
      return { ok: false, error: '旧同期IDの移行結果が正しくありません。' };
    }

    const completed: CompletedLegacySyncUpgrade = {
      syncId: first.sync_id,
      updatedAt: first.updated_at,
    };
    persistPendingLegacySyncCompletion(completed);
    // Once the server winner is durable locally, the legacy bearer secret and
    // candidate are no longer needed. Network/HTTP failures return above and
    // deliberately keep the pending record for a later reload retry.
    clearPendingLegacySyncUpgrade(pending);
    return finalizeCompletedLegacySyncUpgrade(completed, pending.legacySyncId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `旧同期IDを移行できませんでした: ${error.message}` : '旧同期IDを移行できませんでした。',
    };
  }
}

function finalizeCompletedLegacySyncUpgrade(
  completed: CompletedLegacySyncUpgrade,
  legacySyncId?: string,
): SyncResult<LegacySyncUpgrade> {
  const currentSyncId = getStoredSyncId().trim();
  if (currentSyncId !== legacySyncId && currentSyncId !== completed.syncId) {
    return {
      ok: true,
      value: {
        syncId: completed.syncId,
        updatedAt: completed.updatedAt,
        requiresConnectionConfirmation: true,
      },
    };
  }

  if (legacySyncId && currentSyncId === legacySyncId) {
    const persisted = setStoredSyncId(completed.syncId);
    if (!persisted.ok) return persisted;
  }

  // Keep the winner marker until the screen reconciles its own state. If a
  // different tab switches connections immediately after this function returns,
  // the next mount can still offer the winner instead of losing it.
  return { ok: true, value: { syncId: completed.syncId, updatedAt: completed.updatedAt } };
}

type SyncRpcOperation = 'upload' | 'delete' | 'pair_create' | 'pair_redeem' | 'legacy_upgrade';

function syncRpcFailureFromRow(value: unknown, operation: SyncRpcOperation): SyncResult<never> | null {
  if (!isRecord(value) || typeof value.result_code !== 'string' || value.result_code === 'ok') return null;

  const code = value.result_code;
  if (code === 'conflict' || code === 'revision_required') {
    const remoteUpdatedAt = operation === 'upload'
      && typeof value.updated_at === 'string'
      && Number.isFinite(Date.parse(value.updated_at))
      ? value.updated_at
      : undefined;
    return {
      ok: false,
      code: 'conflict',
      remoteUpdatedAt,
      error: operation === 'delete'
        ? '確認後にクラウドデータが更新されたため、削除を中止しました。最新の内容を確認してからやり直してください。'
        : operation === 'legacy_upgrade'
          ? '旧同期データが別の端末で更新されています。現在の端末情報だけでは安全に移行できません。'
          : 'クラウド側に、この端末が最後に確認したものより新しいデータがあります。先にクラウドから読み込んでください。',
    };
  }
  if (code === 'deleted') {
    return {
      ok: false,
      code: 'deleted',
      error: 'この同期先は削除済みです。古い端末から復元せず、新しい同期接続を作成してください。',
    };
  }
  if (code === 'not_found' || code === 'not_found_or_expired') {
    return {
      ok: false,
      code: 'not_found',
      error: operation === 'pair_create'
        ? 'クラウドデータがまだありません。先にこの端末をクラウドへ保存してください。'
        : operation === 'pair_redeem'
          ? '接続コードが違うか、有効期限切れ、または使用済みです。元の端末で新しいコードを発行してください。'
          : operation === 'legacy_upgrade'
            ? 'この旧同期IDのクラウドデータが見つかりません。'
            : '対象のクラウドデータが見つかりません。',
    };
  }
  if (code === 'sync_payload_too_large') {
    return {
      ok: false,
      code: 'payload_too_large',
      error: '同期データが大きすぎます（上限8 MB）。大きなノート画像を整理してから再試行してください。',
    };
  }
  if (code === 'quota_exceeded') {
    return {
      ok: false,
      code: 'quota',
      error: 'クラウド同期の保存上限に達しました。不要な同期データや大きなノート画像を整理してください。',
    };
  }
  if (code === 'migration_expired') {
    return {
      ok: false,
      code: 'invalid',
      error: '旧同期IDの自動移行期間が終了しています。端末内データから新しい同期接続を作成してください。',
    };
  }
  if (code === 'unavailable') {
    return {
      ok: false,
      error: operation === 'pair_create'
        ? '接続コードを発行できませんでした。少し待ってからもう一度お試しください。'
        : '安全な同期IDを作成できませんでした。少し待ってからもう一度お試しください。',
    };
  }
  if (
    code === 'invalid_sync_id'
    || code === 'invalid_sync_payload'
    || code === 'invalid_sync_local_storage'
    || code === 'invalid_sync_notes'
    || code === 'invalid_updated_at'
    || code === 'invalid_pairing_code'
    || code === 'invalid_legacy_sync_id'
  ) {
    return {
      ok: false,
      code: 'invalid',
      error: operation === 'pair_redeem'
        ? '接続コードは8文字で入力してください。'
        : operation === 'legacy_upgrade'
          ? '旧同期IDまたは更新情報の形式が正しくありません。'
          : '同期データまたは同期IDの形式が正しくありません。',
    };
  }

  return { ok: false, error: `同期処理を完了できませんでした（${code}）。` };
}

async function syncRpcHttpError(response: Response, fallback: string): Promise<string> {
  const details = await readSupabaseError(response);
  if (response.status === 429 || details.code === 'rate_limited') {
    return '操作回数が多すぎます。1分ほど待ってからもう一度お試しください。';
  }
  if (response.status === 413) {
    return '同期データが大きすぎます（上限8 MB）。大きなノート画像を整理してから再試行してください。';
  }
  return details.message ? `${fallback} ${details.message}` : fallback;
}

async function responseToDiagnosticStep(response: Response, name: string, successMessage: string): Promise<SyncDiagnosticStep> {
  if (response.ok) return { name, ok: true, message: successMessage };

  const details = await readSupabaseError(response);
  const combined = [details.message, details.code, details.details, details.hint].filter(Boolean).join(' ');
  return {
    name,
    ok: false,
    message: details.message || `HTTP ${response.status}`,
    errorCode: details.code || String(response.status),
    errorDetails: details.details,
    errorHint: details.hint,
    suggestion: getDiagnosticSuggestion(combined),
  };
}

function exceptionToDiagnosticStep(name: string, error: unknown): SyncDiagnosticStep {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name,
    ok: false,
    message,
    errorDetails: message,
    suggestion: getDiagnosticSuggestion(message),
  };
}

async function isMissingSyncRpc(response: Response): Promise<boolean> {
  const details = await readSupabaseError(response.clone());
  const message = details.message.toLowerCase();
  return details.code?.toLowerCase() === 'pgrst202'
    || message.includes('could not find the function');
}

async function readSupabaseError(response: Response): Promise<{ message: string; code?: string; details?: string; hint?: string }> {
  try {
    const text = await response.text();
    if (!text) return { message: `HTTP ${response.status}` };
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return {
        message: typeof parsed.message === 'string' ? parsed.message : text,
        code: typeof parsed.code === 'string' ? parsed.code : undefined,
        details: typeof parsed.details === 'string' ? parsed.details : undefined,
        hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
      };
    } catch {
      return { message: text };
    }
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}

function getDiagnosticSuggestion(errorText: string): string | undefined {
  const value = errorText.toLowerCase();
  if (value.includes('invalid api key') || value.includes('jwt')) {
    return 'ログイン状態を確認して、必要なら一度ログアウトしてから再ログインしてください。解決しない場合は公開APIキーとSupabase URLの組み合わせを確認してください。';
  }
  if (value.includes('relation') && value.includes('quiz_sync_data') && value.includes('does not exist')) {
    return 'Supabase側に quiz_sync_data テーブルがまだ作成されていません。';
  }
  if (
    value.includes('quiz_sync_read')
    || value.includes('quiz_sync_upsert')
    || value.includes('quiz_sync_probe')
    || value.includes('could not find the function')
    || value.includes('pgrst202')
  ) {
    return 'Supabaseへ最新の安全な同期RPCマイグレーションを適用してください。';
  }
  if (value.includes('permission denied') || value.includes('row-level security') || value.includes('rls')) {
    return 'テーブル権限またはRLS設定でブロックされている可能性があります。';
  }
  if (value.includes('failed to fetch') || value.includes('networkerror') || value.includes('load failed')) {
    return 'Supabase URLが間違っている、ネットワーク接続、CORS、またはプロジェクト停止の可能性があります。';
  }
  return undefined;
}

async function getAuthenticatedSyncHeaders(
  config: { anonKey: string },
): Promise<SyncResult<Record<string, string>>> {
  const access = await syncAccessTokenProvider();
  if (!access.ok) {
    return {
      ok: false,
      code: access.reason === 'not-configured' ? undefined : 'authentication_required',
      error: access.message,
    };
  }
  return {
    ok: true,
    value: createSupabaseHeaders(config.anonKey, access.accessToken),
  };
}

function createSupabaseHeaders(
  apiKey: string,
  accessToken: string,
  extra: Record<string, string> = {},
) {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REMOTE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('接続がタイムアウトしました。通信状態を確認してもう一度お試しください。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function responseError(response: Response, fallback: string) {
  return syncRpcHttpError(response, fallback);
}

function parseRemoteRecord(value: unknown, expectedSyncId: string, requireSuccessCode = false): SyncResult<RemoteSyncRecord> {
  if (
    !isRecord(value)
    || (requireSuccessCode && value.result_code !== 'ok')
    || value.sync_id !== expectedSyncId
    || typeof value.updated_at !== 'string'
    || !Number.isFinite(Date.parse(value.updated_at))
    || value.data === undefined
  ) {
    return { ok: false, error: 'クラウドデータの形式が正しくありません。' };
  }

  const validation = validateSyncPayload(value.data);
  if (!validation.ok) return validation;

  return {
    ok: true,
    value: {
      syncId: expectedSyncId,
      payload: validation.value,
      updatedAt: value.updated_at,
    },
  };
}

function collectCurrentQuizMakeLocalStorage(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !isQuizMakeStorageKey(key) || key === APP_DATA_STORAGE_KEY || isCategoryNoteKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) result[key] = value;
    }
  } catch {
    // Best effort snapshot only.
  }
  return result;
}

async function restoreImportedData(
  appDataRaw: string,
  notes: Record<string, string>,
  localStorageSnapshot: Record<string, string>,
  integritySnapshot: DataIntegritySnapshot,
  coordinationLockHeld = false,
): Promise<SyncResult<true>> {
  const failures: string[] = [];
  try {
    if (!await importAppDataRaw(appDataRaw, { coordinationLockHeld })) failures.push('問題データ');
  } catch {
    failures.push('問題データ');
  }
  try {
    await replaceCategoryNotesRaw(notes, { coordinationLockHeld });
  } catch {
    failures.push('ノート');
  }
  try {
    replaceQuizMakeLocalStorage(localStorageSnapshot);
  } catch {
    failures.push('設定');
  }
  try {
    restoreDataIntegritySnapshot(integritySnapshot);
  } catch {
    failures.push('保存状態');
  }
  return failures.length === 0
    ? { ok: true, value: true }
    : { ok: false, error: `${failures.join('・')}を元に戻せませんでした。` };
}

type DataIntegritySnapshot = {
  appExpected: string | null;
  appRecoveryRequired: string | null;
  noteManifest: string | null;
  noteRecoveryRequired: string | null;
  importInProgress: string | null;
};

function captureDataIntegritySnapshot(): DataIntegritySnapshot {
  return {
    appExpected: localStorage.getItem(APP_DATA_EXPECTED_KEY),
    appRecoveryRequired: localStorage.getItem(APP_DATA_RECOVERY_REQUIRED_KEY),
    noteManifest: localStorage.getItem(CATEGORY_NOTES_MANIFEST_KEY),
    noteRecoveryRequired: localStorage.getItem(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY),
    importInProgress: localStorage.getItem(DATA_IMPORT_IN_PROGRESS_KEY),
  };
}

function restoreDataIntegritySnapshot(snapshot: DataIntegritySnapshot): void {
  setOrRemoveLocalStorage(APP_DATA_EXPECTED_KEY, snapshot.appExpected);
  setOrRemoveLocalStorage(APP_DATA_RECOVERY_REQUIRED_KEY, snapshot.appRecoveryRequired);
  setOrRemoveLocalStorage(CATEGORY_NOTES_MANIFEST_KEY, snapshot.noteManifest);
  setOrRemoveLocalStorage(CATEGORY_NOTES_RECOVERY_REQUIRED_KEY, snapshot.noteRecoveryRequired);
  setOrRemoveLocalStorage(DATA_IMPORT_IN_PROGRESS_KEY, snapshot.importInProgress);
}

function setOrRemoveLocalStorage(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

function replaceQuizMakeLocalStorage(next: Record<string, string>): void {
  const before = collectCurrentQuizMakeLocalStorage();
  try {
    const keysToRemove = Object.keys(before).filter((key) => next[key] === undefined);
    Object.entries(next).forEach(([key, value]) => localStorage.setItem(key, value));
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    try {
      Object.keys(collectCurrentQuizMakeLocalStorage()).forEach((key) => localStorage.removeItem(key));
      Object.entries(before).forEach(([key, value]) => localStorage.setItem(key, value));
    } catch {
      // The outer import transaction reports that rollback was incomplete.
    }
    throw error;
  }
}
function isQuizMakeStorageKey(key: string): boolean {
  if (key === APP_DATA_FALLBACK_META_KEY) return false;
  if (key === APP_DATA_EXPECTED_KEY) return false;
  if (key === APP_DATA_RECOVERY_REQUIRED_KEY) return false;
  if (key === CATEGORY_NOTES_MANIFEST_KEY) return false;
  if (key === CATEGORY_NOTES_RECOVERY_REQUIRED_KEY) return false;
  if (key.startsWith('quizMake:sync:')) return false;
  if (key.startsWith('quizMake:cloud:')) return false;
  if (key.startsWith('quizMake:coord:')) return false;
  if (key.startsWith(SYNC_BACKUP_PREFIX)) return false;
  return key === APP_DATA_STORAGE_KEY || key.startsWith('quizMake:') || key.startsWith('quiz-make:');
}

function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.message.toLowerCase().includes('quota')
    || error.message.includes('exceeded the quota');
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.keys(record).sort().reduce<Record<string, string>>((result, key) => {
    result[key] = record[key];
    return result;
  }, {});
}

function runSyncDataOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = syncDataOperationQueue.then(operation, operation);
  syncDataOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function safeGetItem(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function isDataImportInProgress(): boolean {
  try {
    return localStorage.getItem(DATA_IMPORT_IN_PROGRESS_KEY) !== null;
  } catch {
    // An unreadable import marker may represent an interrupted replacement.
    // Do not export/upload until storage becomes readable again.
    return true;
  }
}

function dispatchSyncStateChanged() {
  try {
    window.dispatchEvent(new CustomEvent('quiz-make-sync-state-change'));
  } catch {
    // The verified storage value remains authoritative if notification fails.
  }
}

function dispatchSyncSettingsChanged() {
  try {
    window.dispatchEvent(new CustomEvent('quiz-make-sync-settings-change'));
  } catch {
    // The verified storage value remains authoritative if notification fails.
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function writeLastSyncState(state: Partial<LastSyncState>): void {
  if (state.lastSyncAt !== undefined) localStorage.setItem(LAST_SYNC_AT_KEY, state.lastSyncAt);
  if (state.lastUploadHash !== undefined) localStorage.setItem(LAST_UPLOAD_HASH_KEY, state.lastUploadHash);
  if (state.lastRemoteUpdatedAt !== undefined) localStorage.setItem(LAST_REMOTE_UPDATED_AT_KEY, state.lastRemoteUpdatedAt);
  if (state.status !== undefined) localStorage.setItem(LAST_SYNC_STATUS_KEY, state.status);
  if (state.error !== undefined) {
    if (state.error) localStorage.setItem(LAST_SYNC_ERROR_KEY, state.error);
    else localStorage.removeItem(LAST_SYNC_ERROR_KEY);
  }
}

function writeLegacyLastSyncStateBestEffort(owner: string, state: LastSyncState): void {
  try {
    writeLastSyncState(state);
    if (owner) localStorage.setItem(LAST_SYNC_OWNER_KEY, owner);
    else localStorage.removeItem(LAST_SYNC_OWNER_KEY);
  } catch {
    // The atomic record above is authoritative for current clients.
  }
}

function writeLastSyncStateRecord(owner: string, state: LastSyncState): void {
  localStorage.setItem(LAST_SYNC_RECORD_KEY, JSON.stringify({ owner, state }));
  const persisted = readLastSyncStateRecord();
  if (!persisted || persisted.owner !== owner || !lastSyncStatesEqual(persisted.state, state)) {
    throw new Error('同期状態を端末に保存できませんでした。');
  }
}

function readLastSyncStateRecord(): { owner: string; state: LastSyncState } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_SYNC_RECORD_KEY) ?? 'null') as unknown;
    if (!isRecord(parsed) || typeof parsed.owner !== 'string' || !isRecord(parsed.state)) return null;
    const state = parsed.state;
    if (
      typeof state.lastSyncAt !== 'string'
      || typeof state.lastUploadHash !== 'string'
      || typeof state.lastRemoteUpdatedAt !== 'string'
      || typeof state.status !== 'string'
      || typeof state.error !== 'string'
    ) return null;
    return {
      owner: parsed.owner,
      state: {
        lastSyncAt: state.lastSyncAt,
        lastUploadHash: state.lastUploadHash,
        lastRemoteUpdatedAt: state.lastRemoteUpdatedAt,
        status: state.status,
        error: state.error,
      },
    };
  } catch {
    return null;
  }
}

function lastSyncStatesEqual(left: LastSyncState, right: LastSyncState): boolean {
  return left.lastSyncAt === right.lastSyncAt
    && left.lastUploadHash === right.lastUploadHash
    && left.lastRemoteUpdatedAt === right.lastRemoteUpdatedAt
    && left.status === right.status
    && left.error === right.error;
}

function clearLastSyncStateOwnedBy(syncId: string): void {
  try {
    const atomicRecord = readLastSyncStateRecord();
    if (atomicRecord) {
      if (atomicRecord.owner !== syncId) return;
    } else if (safeGetItem(LAST_SYNC_OWNER_KEY).trim() !== syncId) return;
    [
      LAST_SYNC_AT_KEY,
      LAST_UPLOAD_HASH_KEY,
      LAST_REMOTE_UPDATED_AT_KEY,
      LAST_SYNC_STATUS_KEY,
      LAST_SYNC_ERROR_KEY,
      LAST_SYNC_OWNER_KEY,
      LAST_SYNC_RECORD_KEY,
    ].forEach((key) => localStorage.removeItem(key));
  } catch {
    // The owner check prevents clearing state that already belongs to a newer connection.
  }
}

function emptyLastSyncState(): LastSyncState {
  return {
    lastSyncAt: '',
    lastUploadHash: '',
    lastRemoteUpdatedAt: '',
    status: '',
    error: '',
  };
}

function isCurrentSyncConnection(syncId: string): boolean {
  return getStoredSyncId().trim() === syncId;
}

class SyncConnectionChangedDuringImportError extends Error {
  constructor() {
    super('読み込み中に別のタブで同期接続が変更されたため、読み込む前のデータへ戻しました。');
    this.name = 'SyncConnectionChangedDuringImportError';
  }
}

function assertExpectedSyncConnection(expectedSyncId?: string): void {
  if (expectedSyncId && !isCurrentSyncConnection(expectedSyncId)) {
    throw new SyncConnectionChangedDuringImportError();
  }
}

function syncConnectionChangedResult(): SyncResult<never> {
  return {
    ok: false,
    code: 'connection_changed',
    error: '別の画面またはタブで同期接続が変更されたため、この操作を中止しました。現在の接続を確認してからやり直してください。',
  };
}

function measureJsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null;
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
  } catch {
    return null;
  }
}
