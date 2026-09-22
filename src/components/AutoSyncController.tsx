import { useEffect, useRef } from 'react';
import {
  cleanupLegacySyncBackups,
  computePayloadHash,
  exportQuizMakeData,
  getAutoSyncSettings,
  getLastSyncState,
  getRemoteSyncMeta,
  setLastSyncState,
  uploadSyncData,
} from '../utils/syncService';
import type { ProtectedWorkReason } from '../utils/protectedWork';
import { CLOUD_UPDATE_EVENT, isCloudUpdateDismissed } from '../utils/cloudUpdateNotice';
import { createAutoSyncScheduler, isAutoUploadBlocked, type AutoSyncOutcome } from '../utils/autoSyncScheduler';
import { LOCAL_DATA_SAVED_EVENT } from '../utils/localDataRevision';
import { onCloudAuthStateChange } from '../utils/cloudService';

const AUTO_SYNC_INTERVAL_MS = 60000;
const REMOTE_CHECK_COOLDOWN_MS = 60000;

interface AutoSyncControllerProps {
  protectedWorkReason: ProtectedWorkReason | null;
}

export function AutoSyncController({ protectedWorkReason }: AutoSyncControllerProps) {
  const uploadRunningRef = useRef(false);
  const remoteCheckRunningRef = useRef(false);
  const lastRemoteCheckAtRef = useRef(0);
  const promptedRemoteUpdatedAtRef = useRef('');
  const protectedWorkReasonRef = useRef(protectedWorkReason);
  const previousProtectedWorkReasonRef = useRef(protectedWorkReason);
  const resumeSyncRef = useRef<(() => void) | null>(null);
  protectedWorkReasonRef.current = protectedWorkReason;
  useEffect(() => {
    cleanupLegacySyncBackups();
    let disposed = false;

    const uploadIfChanged = async (): Promise<AutoSyncOutcome> => {
      const settings = getAutoSyncSettings();
      if (disposed || !settings.enabled || !settings.syncId || !settings.configured) return 'paused';
      if (navigator.onLine === false) {
        setLastSyncState({ status: '端末に保存済み・接続後に自動保存します', error: '' });
        return 'paused';
      }
      if (isAutoUploadBlocked(protectedWorkReasonRef.current)) {
        setLastSyncState({ status: '自動同期: 作業終了後に保存します', error: '' });
        return 'paused';
      }
      if (uploadRunningRef.current || remoteCheckRunningRef.current) return 'busy';

      uploadRunningRef.current = true;
      let shouldCheckRemoteAfterUpload = false;
      try {
        const payload = await exportQuizMakeData();
        const currentSettings = getAutoSyncSettings();
        if (disposed || !currentSettings.enabled || currentSettings.syncId !== settings.syncId) return 'paused';
        if (isAutoUploadBlocked(protectedWorkReasonRef.current)) {
          setLastSyncState({ status: '自動同期: 作業終了後に保存します', error: '' });
          return 'paused';
        }
        const hash = computePayloadHash(payload);
        const lastState = getLastSyncState();
        if (!lastState.lastSyncAt && !lastState.lastUploadHash) {
          setLastSyncState({ status: '自動同期: 初回は手動保存または読み込みをしてください', error: '' });
          return 'paused';
        }
        if (hash === lastState.lastUploadHash) {
          setLastSyncState({ status: '自動同期: 待機中', error: '' });
          return 'done';
        }

        setLastSyncState({ status: '自動保存中...', error: '' });
        const result = await uploadSyncData(settings.syncId, payload, {
          expectedRemoteUpdatedAt: lastState.lastSyncAt || null,
          force: false,
        });
        const latestSettings = getAutoSyncSettings();
        if (disposed || !latestSettings.enabled || latestSettings.syncId !== settings.syncId) return 'paused';
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
          if (result.code === 'conflict') shouldCheckRemoteAfterUpload = true;
          if (result.code === 'rate_limited') return 'rate_limited';
          return result.code ? 'paused' : 'retry';
        }
        if (result.value.localChangesPending) {
          return 'changed';
        }
        setLastSyncState({ status: '自動保存しました', error: '' });
        return 'done';
      } catch (error) {
        const latestSettings = getAutoSyncSettings();
        if (disposed || !latestSettings.enabled || latestSettings.syncId !== settings.syncId) return 'paused';
        const message = error instanceof Error ? error.message : '自動保存に失敗しました。';
        console.warn('Auto sync upload failed.', error);
        setLastSyncState({ status: '端末のデータを保持して再試行します', error: message });
        return 'retry';
      } finally {
        uploadRunningRef.current = false;
        if (!disposed && shouldCheckRemoteAfterUpload) void checkRemote(true);
      }
    };

    const uploadQueue = createAutoSyncScheduler(uploadIfChanged, {
      now: Date.now,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer),
    });

    const checkRemote = async (force = false) => {
      const settings = getAutoSyncSettings();
      if (disposed || navigator.onLine === false || !settings.syncId || !settings.configured) return;
      if (remoteCheckRunningRef.current || uploadRunningRef.current) return;

      const now = Date.now();
      if (!force && now - lastRemoteCheckAtRef.current < REMOTE_CHECK_COOLDOWN_MS) return;
      lastRemoteCheckAtRef.current = now;
      remoteCheckRunningRef.current = true;

      try {
        const meta = await getRemoteSyncMeta(settings.syncId);
        const latestSettings = getAutoSyncSettings();
        if (disposed || latestSettings.syncId !== settings.syncId) return;
        if (!meta.ok) {
          if (meta.code !== 'authentication_required') console.warn('Auto sync remote check failed.', meta.error);
          setLastSyncState({
            status: meta.code === 'authentication_required' ? '自動同期: ログインが必要です' : 'クラウド確認失敗',
            error: meta.error,
          });
          return;
        }
        if (!meta.value) {
          setLastSyncState({ status: 'クラウドデータなし', error: '' });
          return;
        }

        const lastState = getLastSyncState();
        setLastSyncState({ lastRemoteUpdatedAt: meta.value.updatedAt });
        const remoteHasChanged = meta.value.updatedAt !== lastState.lastSyncAt;
        if (!remoteHasChanged) return;
        const promptKey = `${settings.syncId}:${meta.value.updatedAt}`;
        if (promptedRemoteUpdatedAtRef.current === promptKey || isCloudUpdateDismissed({ syncId: settings.syncId, updatedAt: meta.value.updatedAt })) return;
        // Notify from lightweight revision metadata. Download/compare content only
        // when the user chooses to review it; never advance the sync baseline here.
        promptedRemoteUpdatedAtRef.current = promptKey;
        setLastSyncState({ status: 'クラウドの更新を確認してください', error: '' });
        window.dispatchEvent(new CustomEvent(CLOUD_UPDATE_EVENT, { detail: { syncId: settings.syncId, updatedAt: meta.value.updatedAt } }));
        // Resolve differences only when the user opens Settings > Sync.
      } catch (error) {
        if (disposed || getAutoSyncSettings().syncId !== settings.syncId) return;
        const message = error instanceof Error ? error.message : 'クラウド確認に失敗しました。';
        console.warn('Auto sync remote check failed.', error);
        setLastSyncState({ status: 'クラウド確認失敗', error: message });
      } finally {
        remoteCheckRunningRef.current = false;
      }
    };

    resumeSyncRef.current = () => {
      uploadQueue.request(true);
      void checkRemote(true);
    };

    const intervalId = window.setInterval(() => uploadQueue.request(), AUTO_SYNC_INTERVAL_MS);
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
      uploadQueue.request(true);
      void checkRemote(true);
    };
    const handleLocalSave = () => uploadQueue.request(document.visibilityState === 'hidden');
    const handlePageHide = () => uploadQueue.request(true);
    // Supabase's auth callback holds a session lock; the queue defers Auth calls.
    const unsubscribeAuth = onCloudAuthStateChange(() => uploadQueue.request(true));

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
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleFocus);
      window.removeEventListener('pageshow', handleFocus);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener(LOCAL_DATA_SAVED_EVENT, handleLocalSave);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('quiz-make-sync-settings-change', handleSettingsChange);
      resumeSyncRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previousReason = previousProtectedWorkReasonRef.current;
    previousProtectedWorkReasonRef.current = protectedWorkReason;
    if (previousReason !== protectedWorkReason && !isAutoUploadBlocked(protectedWorkReason)) resumeSyncRef.current?.();
  }, [protectedWorkReason]);

  return null;
}
