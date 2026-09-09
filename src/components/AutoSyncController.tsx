import { useEffect, useRef } from 'react';
import {
  cleanupLegacySyncBackups,
  computePayloadHash,
  downloadSyncData,
  exportQuizMakeData,
  getAutoSyncSettings,
  getLastSyncState,
  getRemoteSyncMeta,
  setLastSyncState,
  setLastSyncStateForConnection,
  uploadSyncData,
} from '../utils/syncService';
import type { ProtectedWorkReason } from '../utils/protectedWork';

const AUTO_SYNC_INTERVAL_MS = 60000;
const REMOTE_CHECK_COOLDOWN_MS = 60000;
const LOCAL_CHANGE_RETRY_MS = 750;

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
    let localChangeRetryTimer: number | null = null;

    const uploadIfChanged = async () => {
      const settings = getAutoSyncSettings();
      if (!settings.enabled || !settings.syncId || !settings.configured) return;
      if (protectedWorkReasonRef.current) {
        setLastSyncState({ status: '自動同期: 作業終了後に保存します', error: '' });
        return;
      }
      if (uploadRunningRef.current || remoteCheckRunningRef.current) return;

      uploadRunningRef.current = true;
      let shouldCheckRemoteAfterUpload = false;
      let shouldRetryLocalChanges = false;
      try {
        const payload = await exportQuizMakeData();
        if (protectedWorkReasonRef.current) {
          setLastSyncState({ status: '自動同期: 作業終了後に保存します', error: '' });
          return;
        }
        const hash = computePayloadHash(payload);
        const lastState = getLastSyncState();
        if (!lastState.lastSyncAt && !lastState.lastUploadHash) {
          setLastSyncState({ status: '自動同期: 初回は手動保存または読み込みをしてください', error: '' });
          return;
        }
        if (hash === lastState.lastUploadHash) {
          setLastSyncState({ status: '自動同期: 待機中', error: '' });
          return;
        }

        setLastSyncState({ status: '自動保存中...', error: '' });
        const result = await uploadSyncData(settings.syncId, payload, {
          expectedRemoteUpdatedAt: lastState.lastSyncAt || null,
          force: false,
        });
        const latestSettings = getAutoSyncSettings();
        if (!latestSettings.enabled || latestSettings.syncId !== settings.syncId) return;
        if (!result.ok) {
          if (result.code === 'local_changed') {
            shouldRetryLocalChanges = true;
            setLastSyncState({ status: '自動同期: 最新の変更を再確認中...', error: '' });
            return;
          }
          if (result.code !== 'authentication_required') console.warn('Auto sync upload failed.', result.error);
          setLastSyncState({
            status: result.code === 'authentication_required'
              ? '自動同期: ログインが必要です'
              : result.code === 'conflict'
                ? 'クラウドに新しいデータがあります'
                : '自動同期失敗',
            error: result.error,
          });
          if (result.code === 'conflict') shouldCheckRemoteAfterUpload = true;
          return;
        }
        if (result.value.localChangesPending) {
          shouldRetryLocalChanges = true;
          return;
        }
        setLastSyncState({ status: '自動保存しました', error: '' });
      } catch (error) {
        const message = error instanceof Error ? error.message : '自動保存に失敗しました。';
        console.warn('Auto sync upload failed.', error);
        setLastSyncState({ status: '自動同期失敗', error: message });
      } finally {
        uploadRunningRef.current = false;
        if (shouldRetryLocalChanges) scheduleLocalChangeRetry();
        if (shouldCheckRemoteAfterUpload) void checkRemote(true);
      }
    };

    const scheduleLocalChangeRetry = () => {
      if (localChangeRetryTimer !== null) window.clearTimeout(localChangeRetryTimer);
      localChangeRetryTimer = window.setTimeout(() => {
        localChangeRetryTimer = null;
        if (uploadRunningRef.current || remoteCheckRunningRef.current) {
          scheduleLocalChangeRetry();
          return;
        }
        void uploadIfChanged();
      }, LOCAL_CHANGE_RETRY_MS);
    };

    const checkRemote = async (force = false) => {
      const settings = getAutoSyncSettings();
      if (!settings.enabled || !settings.syncId || !settings.configured) return;
      if (remoteCheckRunningRef.current || uploadRunningRef.current) return;

      const now = Date.now();
      if (!force && now - lastRemoteCheckAtRef.current < REMOTE_CHECK_COOLDOWN_MS) return;
      lastRemoteCheckAtRef.current = now;
      remoteCheckRunningRef.current = true;

      try {
        const meta = await getRemoteSyncMeta(settings.syncId);
        const latestSettings = getAutoSyncSettings();
        if (!latestSettings.enabled || latestSettings.syncId !== settings.syncId) return;
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
        // A different timestamp does not mean the cloud contains newer learning data.
        const remote = await downloadSyncData(settings.syncId);
        if (!remote.ok || !remote.value) return;
        const currentSettings = getAutoSyncSettings();
        if (!currentSettings.enabled || currentSettings.syncId !== settings.syncId) return;
        const localHash = computePayloadHash(await exportQuizMakeData());
        if (localHash === computePayloadHash(remote.value.payload)) {
          setLastSyncStateForConnection(settings.syncId, {
            lastSyncAt: remote.value.updatedAt,
            lastRemoteUpdatedAt: remote.value.updatedAt,
            lastUploadHash: localHash,
            status: '端末とクラウドは同じ内容です', error: '',
          });
          return;
        }
        const promptKey = `${settings.syncId}:${meta.value.updatedAt}`;
        if (promptedRemoteUpdatedAtRef.current === promptKey) return;

        promptedRemoteUpdatedAtRef.current = promptKey;
        setLastSyncState({ status: '端末とクラウドに異なる内容があります', error: '' });
        // Resolve differences only when the user opens Settings > Sync.
      } catch (error) {
        const message = error instanceof Error ? error.message : 'クラウド確認に失敗しました。';
        console.warn('Auto sync remote check failed.', error);
        setLastSyncState({ status: 'クラウド確認失敗', error: message });
      } finally {
        remoteCheckRunningRef.current = false;
      }
    };

    resumeSyncRef.current = () => {
      void uploadIfChanged().then(() => checkRemote(true));
    };

    const intervalId = window.setInterval(uploadIfChanged, AUTO_SYNC_INTERVAL_MS);
    const handleFocus = () => void checkRemote(false);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void checkRemote(false);
    };
    const handleSettingsChange = () => {
      void checkRemote(true);
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('quiz-make-sync-settings-change', handleSettingsChange);

    window.setTimeout(() => void checkRemote(true), 1200);

    return () => {
      window.clearInterval(intervalId);
      if (localChangeRetryTimer !== null) window.clearTimeout(localChangeRetryTimer);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('quiz-make-sync-settings-change', handleSettingsChange);
      resumeSyncRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previousReason = previousProtectedWorkReasonRef.current;
    previousProtectedWorkReasonRef.current = protectedWorkReason;
    if (previousReason && !protectedWorkReason) resumeSyncRef.current?.();
  }, [protectedWorkReason]);

  return null;
}
