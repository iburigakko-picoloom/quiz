import { useEffect, useRef } from 'react';
import {
  cleanupLegacySyncBackups,
  computePayloadHash,
  computePayloadDigest,
  downloadSyncData,
  exportQuizMakeData,
  getAutoSyncSettings,
  getLastSyncState,
  isLocalSyncUnchanged,
  getRemoteSyncMeta,
  getRemoteSyncConfig,
  setLastSyncState,
  setLastSyncStateForConnection,
  uploadSyncData,
  type RemoteSyncRecord,
} from '../utils/syncService';
import { getSyncDecision } from '../utils/syncDecision';
import type { ProtectedWorkReason } from '../utils/protectedWork';
import { CLOUD_UPDATE_EVENT, isCloudUpdateDismissed } from '../utils/cloudUpdateNotice';
import { createAutoSyncScheduler, isAutoUploadBlocked, type AutoSyncOutcome, type AutoSyncQueueState } from '../utils/autoSyncScheduler';
import { LOCAL_DATA_SAVED_EVENT } from '../utils/localDataRevision';
import { getCloudSession, onCloudAuthStateChange } from '../utils/cloudService';
import { runAppRecordSync } from '../utils/recordSyncCoordinator';
import { RecordSyncRpcError } from '../utils/recordSyncNetwork';
import type { RecordSyncGuards } from '../utils/recordSyncEngine';
import { isRecordSyncOptedIn } from '../utils/recordSyncOptIn';
import { SYNC_RETRY_EVENT, runSelectedSync, finishManualSync } from '../utils/syncRequest';
import { isSyncInteractionProtected } from '../utils/syncInteraction';
import { SyncInterruptedError, SyncLocalPersistenceError } from '../utils/syncInterruption';
import { clearSyncAttemptStatus, isBlockedSyncFailure, observeRecordSyncAttempt, publishRemoteCheck, publishSyncAttempt, publishSyncQueue } from '../utils/syncAttemptStatus';

const AUTO_SYNC_INTERVAL_MS = 60000;
const REMOTE_CHECK_COOLDOWN_MS = 5000;

interface AutoSyncControllerProps {
  protectedWorkReason: ProtectedWorkReason | null;
  canAutoImport: () => boolean;
  autoImportReady: boolean;
  onAutoImport: (remote: RemoteSyncRecord, expectedLocalDigest: string) => Promise<boolean>;
  onRecordApply: RecordSyncGuards['apply'];
}

export function AutoSyncController({ protectedWorkReason, canAutoImport, autoImportReady, onAutoImport, onRecordApply }: AutoSyncControllerProps) {
  const uploadRunningRef = useRef(false);
  const remoteCheckRunningRef = useRef(false);
  const lastRemoteCheckAtRef = useRef(0);
  const promptedRemoteUpdatedAtRef = useRef('');
  const protectedWorkReasonRef = useRef(protectedWorkReason);
  const previousProtectedWorkReasonRef = useRef(protectedWorkReason);
  const resumeSyncRef = useRef<(() => void) | null>(null);
  const importHandlersRef = useRef({ canAutoImport, onAutoImport, onRecordApply });
  importHandlersRef.current = { canAutoImport, onAutoImport, onRecordApply };
  protectedWorkReasonRef.current = protectedWorkReason;
  useEffect(() => {
    cleanupLegacySyncBackups();
    let disposed = false;
    let lastConflictKey = '';
    let manualRequest = false;
    let manualSyncId = '';
    let manualScope = '';
    let userId = '';
    let authVersion = 0;
    let blockedFailure: { scope: string; code: string } | null = null;
    let queueState: AutoSyncQueueState = { phase: 'idle', retryAt: null };
    const attemptConnection = () => {
      const config = getRemoteSyncConfig(), settings = getAutoSyncSettings();
      return config && settings.syncId && userId ? { project: new URL(config.url).origin, syncId: settings.syncId, userId } : null;
    };
    const manualContext = () => {
      const config = getRemoteSyncConfig(), settings = getAutoSyncSettings();
      return config && settings.syncId && userId
        ? JSON.stringify([config.url, config.anonKey, userId, settings.syncId, isRecordSyncOptedIn(settings.syncId)]) : '';
    };
    const stopManualSync = (syncId = manualSyncId) => {
      if (syncId === manualSyncId) { manualRequest = false; manualSyncId = ''; manualScope = ''; }
      finishManualSync(syncId);
    };
    const publishQueue = () => { const connection = attemptConnection(); if (connection) publishSyncQueue(connection, queueState); };
    const paused = (reason: string) => { const connection = attemptConnection(); if (!disposed && connection) publishSyncAttempt(connection, { phase: 'paused', pauseReason: reason }); };
    const failure = (step: string, code: string, message: string, connection = attemptConnection()) => {
      const current = attemptConnection();
      if (!disposed && connection && current?.project === connection.project && current?.userId === connection.userId && current?.syncId === connection.syncId) {
        publishSyncAttempt(connection, { phase: 'failed', lastFailure: { step, code, message, at: new Date().toISOString() } });
      }
    };
    const completed = (connection: ReturnType<typeof attemptConnection>) => {
      const current = attemptConnection();
      if (!disposed && connection && current?.project === connection.project && current?.userId === connection.userId && current?.syncId === connection.syncId) {
        publishSyncAttempt(connection, { phase: 'done', pauseReason: '' });
      }
    };
    const bootstrapVersion = authVersion;
    const sessionReady = getCloudSession().then(session => {
      if (disposed || bootstrapVersion !== authVersion) return;
      userId = session?.user && !session.user.is_anonymous ? session.user.id : ''; publishQueue();
    }).catch(() => { /* The coordinator reports authentication errors. */ });

    const tryRecordSync = async (syncId: string, manual: boolean): Promise<AutoSyncOutcome> => {
      const connection = attemptConnection();
      const current = () => !disposed && getAutoSyncSettings().syncId === syncId && (!connection || attemptConnection()?.userId === connection.userId && attemptConnection()?.project === connection.project);
      const observed = await observeRecordSyncAttempt(step => runAppRecordSync(syncId, operation => importHandlersRef.current.onRecordApply(operation), manual, step),
        update => { if (connection && current()) publishSyncAttempt(connection, update); });
      if (!current()) return 'paused';
      const result = observed.result;
      if (result) {
        blockedFailure = null;
        if (result.status === 'more') { setLastSyncState({ status: '同期中', error: '' }); return 'changed'; }
        if (result.status === 'deferred') { setLastSyncState({ status: '変更の反映を待っています', error: '' }); return 'paused'; }
        if (result.status === 'conflict') {
          setLastSyncState({ status: 'クラウドと端末の編集が競合しています', error: '両方の内容を保存しています。同期画面で確認してください。' });
          window.dispatchEvent(new CustomEvent(CLOUD_UPDATE_EVENT, { detail: { syncId, updatedAt: getLastSyncState().lastRemoteUpdatedAt } }));
          return 'paused';
        }
        setLastSyncState({ status: '同期済み', error: '' });
        return 'done';
      }
      const error = observed.error;
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && isBlockedSyncFailure(error.code)) {
        blockedFailure = { scope: manualContext(), code: error.code };
        stopManualSync(syncId);
      }
      if (error instanceof SyncLocalPersistenceError) {
        setLastSyncState({ status: '端末への保存を確認してください', error: error.message });
        return 'paused';
      }
      if (error instanceof SyncInterruptedError) {
        setLastSyncState({ status: '内容の確認が終わってから同期を再開します', error: '' }); return 'paused';
      }
      if (error instanceof RecordSyncRpcError && ['unavailable', 'media_unsupported', 'legacy_snapshot'].includes(error.code)) {
        setLastSyncState({ status: '高速同期の確認が必要です', error: error.message });
        return 'paused';
      }
      setLastSyncState({ status: error instanceof RecordSyncRpcError && error.code === 'authentication_required' ? 'ログインが必要です' : '端末のデータを保持して再試行します', error: error instanceof Error ? error.message : '差分同期に失敗しました。' });
      return observed.outcome;
    };

    const uploadIfChanged = async (): Promise<AutoSyncOutcome> => {
      const settings = getAutoSyncSettings();
      const manual = manualRequest;
      if (disposed || (!settings.enabled && !manual) || !settings.syncId || !settings.configured) { paused('disabled'); return 'paused'; }
      if (blockedFailure?.scope === manualContext() && !manual) { paused(blockedFailure.code); return 'paused'; }
      if (navigator.onLine === false) {
        setLastSyncState({ status: '端末に保存済み・接続後に自動保存します', error: '' });
        paused('offline');
        return 'paused';
      }
      if ((isAutoUploadBlocked(protectedWorkReasonRef.current) || isSyncInteractionProtected())) {
        setLastSyncState({ status: '自動同期: 作業終了後に保存します', error: '' });
        paused('protected_work');
        return 'paused';
      }
      if (uploadRunningRef.current || remoteCheckRunningRef.current) return 'busy';

      uploadRunningRef.current = true;
      const uploadConnection = attemptConnection();
      let legacyStep = 'local_data';
      let shouldCheckRemoteAfterUpload = manual && !isRecordSyncOptedIn(settings.syncId);
      try {
        const outcome = await runSelectedSync<AutoSyncOutcome>(isRecordSyncOptedIn(settings.syncId),
          () => tryRecordSync(settings.syncId, manual), async () => {
            if (await isLocalSyncUnchanged(getLastSyncState().lastSyncDigest)) {
              setLastSyncState({ status: '自動同期: 待機中', error: '' });
              return 'done';
            }
            const payload = await exportQuizMakeData();
            const currentSettings = getAutoSyncSettings();
            if (disposed || (!currentSettings.enabled && !manual) || currentSettings.syncId !== settings.syncId) return 'paused';
            if ((isAutoUploadBlocked(protectedWorkReasonRef.current) || isSyncInteractionProtected())) {
              setLastSyncState({ status: '自動同期: 作業終了後に保存します', error: '' });
              return 'paused';
            }
            const lastState = getLastSyncState();
            if (isRecordSyncOptedIn(settings.syncId)) return 'changed';
            if (!lastState.lastSyncAt && !lastState.lastUploadHash) {
              setLastSyncState({ status: '自動同期: 初回は手動保存または読み込みをしてください', error: '' });
              return 'paused';
            }
            if (lastState.lastSyncDigest
              ? await computePayloadDigest(payload) === lastState.lastSyncDigest
              : computePayloadHash(payload) === lastState.lastUploadHash) {
              setLastSyncState({ status: '自動同期: 待機中', error: '' });
              return 'done';
            }

            setLastSyncState({ status: '自動保存中...', error: '' });
            legacyStep = 'snapshot_upload';
            const result = await uploadSyncData(settings.syncId, payload, {
              expectedRemoteUpdatedAt: lastState.lastSyncAt || null,
              force: false,
        });
        const latestSettings = getAutoSyncSettings();
        if (disposed || (!latestSettings.enabled && !manual) || latestSettings.syncId !== settings.syncId) return 'paused';
        if (!result.ok) {
          if (result.code === 'local_changed') {
            setLastSyncState({ status: '自動同期: 最新の変更を再確認中...', error: '' });
            return 'changed';
          }
          if (result.code !== 'authentication_required') console.warn('Auto sync upload failed.', result.error);
          setLastSyncState({
            status: result.code === 'authentication_required'
              ? '自動同期: ログインが必要です'
              : result.code === 'conflict'
                ? 'クラウドに新しいデータがあります'
                : result.code && result.code !== 'rate_limited'
                  ? '自動同期: 確認が必要です'
                  : '端末に保存済み・クラウド保存を再試行します',
            error: result.error,
          });
          if (result.code === 'conflict') paused('conflict');
          else failure(legacyStep, result.code ?? 'network', result.error, uploadConnection);
          if (result.code === 'conflict') shouldCheckRemoteAfterUpload = true;
          if (result.code === 'rate_limited') return 'rate_limited';
          return result.code ? 'paused' : 'retry';
        }
        if (result.value.localChangesPending) {
          return 'changed';
        }
        setLastSyncState({ status: '自動保存しました', error: '' });
        completed(uploadConnection);
        return 'done';
        });
        if (outcome === 'done' && isRecordSyncOptedIn(settings.syncId)) stopManualSync(settings.syncId);
        if (outcome === 'done' && isRecordSyncOptedIn(settings.syncId)) completed(uploadConnection);
        return outcome;
      } catch (error) {
        const latestSettings = getAutoSyncSettings();
        if (disposed || (!latestSettings.enabled && !manual) || latestSettings.syncId !== settings.syncId) return 'paused';
        const message = error instanceof Error ? error.message : '自動保存に失敗しました。';
        if (error instanceof SyncLocalPersistenceError) {
          blockedFailure = { scope: manualContext(), code: error.code }; stopManualSync(settings.syncId);
          setLastSyncState({ status: '端末への保存を確認してください', error: message });
          failure('local_persistence', error.code, message, uploadConnection);
          paused(error.code); return 'paused';
        }
        console.warn('Auto sync upload failed.', error);
        setLastSyncState({ status: '端末のデータを保持して再試行します', error: message });
        failure(legacyStep, error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unexpected', message, uploadConnection);
        return 'retry';
      } finally {
        uploadRunningRef.current = false;
        if (!disposed && shouldCheckRemoteAfterUpload) void checkRemote(true).finally(() => {
          if (manual) stopManualSync(settings.syncId);
        });
      }
    };

    const uploadQueue = createAutoSyncScheduler(uploadIfChanged, {
      now: Date.now,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    }, state => { queueState = state; publishQueue(); });

    const checkRemote = async (force = false) => {
      const settings = getAutoSyncSettings();
      if (disposed || navigator.onLine === false || !settings.syncId || !settings.configured) return;
      if (remoteCheckRunningRef.current || uploadRunningRef.current) return;

      const now = Date.now();
      if (!force && now - lastRemoteCheckAtRef.current < REMOTE_CHECK_COOLDOWN_MS) return;
      lastRemoteCheckAtRef.current = now;
      remoteCheckRunningRef.current = true;
      let remoteConnection = attemptConnection();
      let remoteStep = 'remote_metadata';

      try {
        if (isRecordSyncOptedIn(settings.syncId)) {
          if (settings.enabled || manualRequest) uploadQueue.request(true);
          return;
        }
        // Startup reconciliation can begin before the cached session resolves.
        // Establish the display scope before marking its remote I/O as running.
        await sessionReady;
        if (disposed || getAutoSyncSettings().syncId !== settings.syncId) return;
        remoteConnection = attemptConnection();
        if (remoteConnection) publishRemoteCheck(remoteConnection, true);
        const meta = await getRemoteSyncMeta(settings.syncId);
        const latestSettings = getAutoSyncSettings();
        if (disposed || latestSettings.syncId !== settings.syncId) return;
        if (!meta.ok) {
          if (meta.code !== 'authentication_required') console.warn('Auto sync remote check failed.', meta.error);
          setLastSyncState({
            status: meta.code === 'authentication_required' ? '自動同期: ログインが必要です' : 'クラウド確認失敗',
            error: meta.error,
          });
          failure(remoteStep, meta.code ?? 'network', meta.error, remoteConnection);
          return;
        }
        if (!meta.value) {
          setLastSyncState({ status: 'クラウドデータなし', error: '' });
          paused('remote_missing');
          return;
        }

        const lastState = getLastSyncState();
        setLastSyncState({ lastRemoteUpdatedAt: meta.value.updatedAt });
        const remoteHasChanged = meta.value.updatedAt !== lastState.lastSyncAt;
        if (remoteHasChanged) paused('deferred');
        const canReconcile = () => !disposed && (getAutoSyncSettings().enabled || manualRequest)
          && getAutoSyncSettings().syncId === settings.syncId && !isRecordSyncOptedIn(settings.syncId)
          && document.visibilityState === 'visible' && protectedWorkReasonRef.current === null
          && importHandlersRef.current.canAutoImport();
        // A one-time full comparison establishes a strong ancestor for older
        // clients. A legacy 32-bit hash alone never authorizes an auto import.
        if ((remoteHasChanged || !lastState.lastSyncDigest) && canReconcile()) {
          const local = await exportQuizMakeData();
          const localDigest = await computePayloadDigest(local);
          const conflictKey = `${settings.syncId}:${meta.value.updatedAt}:${localDigest}`;
          if (lastConflictKey === conflictKey) return;
          if (!canReconcile()) return;
          remoteStep = 'snapshot_download';
          const remote = await downloadSyncData(settings.syncId, { localPayload: local });
          if (!remote.ok) throw new Error(remote.error);
          if (!remote.value || !canReconcile()) return;
          const remoteDigest = await computePayloadDigest(remote.value.payload);
          if (!canReconcile()) return;
          const decision = getSyncDecision(getLastSyncState(), localDigest, { updatedAt: remote.value.updatedAt, digest: remoteDigest });
          if (decision === 'same') {
            setLastSyncStateForConnection(settings.syncId, { lastSyncAt: remote.value.updatedAt,
              lastUploadHash: computePayloadHash(local), lastSyncDigest: localDigest,
              lastRemoteUpdatedAt: remote.value.updatedAt, status: '同期済み', error: '' });
            completed(remoteConnection);
            return;
          }
          if (decision === 'download') {
            setLastSyncState({ status: 'クラウドの更新を取り込み中…', error: '' });
            if (await importHandlersRef.current.onAutoImport(remote.value, localDigest)) {
              completed(remoteConnection); return;
            }
            // Local changes/new work during download are re-evaluated later.
            lastRemoteCheckAtRef.current = 0;
            return;
          }
          if (decision === 'upload') { uploadQueue.request(true); return; }
          lastConflictKey = conflictKey;
        }
        if (!remoteHasChanged) {
          completed(remoteConnection);
          return;
        }
        const promptKey = `${settings.syncId}:${meta.value.updatedAt}`;
        if (promptedRemoteUpdatedAtRef.current === promptKey || isCloudUpdateDismissed({ syncId: settings.syncId, updatedAt: meta.value.updatedAt })) return;
        // Conflicts, first sync and protected screens keep the existing notice.
        // Observing a revision alone never advances the accepted sync baseline.
        promptedRemoteUpdatedAtRef.current = promptKey;
        setLastSyncState({ status: 'クラウドの更新を確認してください', error: '' });
        window.dispatchEvent(new CustomEvent(CLOUD_UPDATE_EVENT, { detail: { syncId: settings.syncId, updatedAt: meta.value.updatedAt } }));
      } catch (error) {
        if (disposed || getAutoSyncSettings().syncId !== settings.syncId) return;
        const message = error instanceof Error ? error.message : 'クラウド確認に失敗しました。';
        console.warn('Auto sync remote check failed.', error);
        setLastSyncState({ status: 'クラウド確認失敗', error: message });
        failure(remoteStep, error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unexpected', message, remoteConnection);
      } finally {
        remoteCheckRunningRef.current = false;
        if (!disposed && remoteConnection && attemptConnection()?.userId === remoteConnection.userId && attemptConnection()?.syncId === remoteConnection.syncId && attemptConnection()?.project === remoteConnection.project) publishRemoteCheck(remoteConnection, false);
      }
    };

    resumeSyncRef.current = () => {
      uploadQueue.request(true);
      void checkRemote(true);
    };

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') void checkRemote(false);
      uploadQueue.request();
    }, AUTO_SYNC_INTERVAL_MS);
    const handleFocus = () => {
      uploadQueue.request(true);
      void checkRemote(false);
    };
    const handleVisibility = () => {
      // Leaving is only best-effort: browsers may suspend network immediately.
      // Startup/return always compares the durable local payload again.
      uploadQueue.request(true);
      if (document.visibilityState === 'visible') void checkRemote(false);
    };
    const handleSettingsChange = () => {
      if (manualRequest && manualScope !== manualContext()) stopManualSync();
      uploadQueue.request(true);
      void checkRemote(true);
    };
    const handleRetry = (event: Event) => {
      if ((event as CustomEvent<{ syncId: string }>).detail?.syncId !== getAutoSyncSettings().syncId) return;
      manualRequest = true;
      manualSyncId = getAutoSyncSettings().syncId;
      manualScope = manualContext();
      uploadQueue.request(true);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith('quizMake:sync:')) {
        handleSettingsChange();
      }
    };
    const handleLocalSave = () => { blockedFailure = null; uploadQueue.request(document.visibilityState === 'hidden'); };
    const handlePageHide = () => uploadQueue.request(true);
    // Supabase's auth callback holds a session lock; the queue defers Auth calls.
    let authCheckTimer: number | undefined;
    const unsubscribeAuth = onCloudAuthStateChange((_event, session) => {
      authVersion++;
      const nextUserId = session?.user && !session.user.is_anonymous ? session.user.id : '';
      if (_event === 'SIGNED_OUT' || nextUserId !== userId) { blockedFailure = null; stopManualSync(); clearSyncAttemptStatus(); }
      userId = nextUserId; publishQueue();
      uploadQueue.request(true);
      window.clearTimeout(authCheckTimer);
      authCheckTimer = window.setTimeout(() => void checkRemote(true), 0);
    });

    window.addEventListener(SYNC_RETRY_EVENT, handleRetry);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleFocus);
    window.addEventListener('pageshow', handleFocus);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener(LOCAL_DATA_SAVED_EVENT, handleLocalSave);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('quiz-make-sync-settings-change', handleSettingsChange);

    const initialCheckTimer = window.setTimeout(() => void checkRemote(true), 0);
    uploadQueue.request(true);

    return () => {
      disposed = true;
      uploadQueue.dispose();
      unsubscribeAuth();
      window.clearInterval(intervalId);
      window.clearTimeout(initialCheckTimer);
      window.clearTimeout(authCheckTimer);
      window.removeEventListener(SYNC_RETRY_EVENT, handleRetry);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleFocus);
      window.removeEventListener('pageshow', handleFocus);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener(LOCAL_DATA_SAVED_EVENT, handleLocalSave);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('quiz-make-sync-settings-change', handleSettingsChange);
      resumeSyncRef.current = null;
      clearSyncAttemptStatus();
    };
  }, []);

  useEffect(() => {
    const previousReason = previousProtectedWorkReasonRef.current;
    previousProtectedWorkReasonRef.current = protectedWorkReason;
    if (previousReason !== protectedWorkReason && !isAutoUploadBlocked(protectedWorkReason)) resumeSyncRef.current?.();
  }, [protectedWorkReason]);

  useEffect(() => {
    if (autoImportReady) resumeSyncRef.current?.();
  }, [autoImportReady]);

  return null;
}
