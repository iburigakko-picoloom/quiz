import { useEffect, useRef, useState } from 'react';
import {
  cleanupLegacySyncBackups,
  computePayloadHash,
  downloadSyncData,
  exportQuizMakeData,
  getAutoSyncSettings,
  getLastSyncState,
  getRemoteSyncMeta,
  importQuizMakeData,
  setLastSyncState,
  setLastSyncStateForConnection,
  uploadSyncData,
} from '../utils/syncService';
import type { ProtectedWorkReason } from '../utils/protectedWork';
import { ConfirmDialog } from './ConfirmDialog';

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
  const [pendingRemoteImport, setPendingRemoteImport] = useState<{ syncId: string; updatedAt: string; localHash: string } | null>(null);
  const [remoteImportBusy, setRemoteImportBusy] = useState(false);

  const cancelRemoteImport = () => {
    if (remoteImportBusy) return;
    setPendingRemoteImport(null);
    setLastSyncState({ status: 'クラウド読み込みを保留しました', error: '' });
  };

  const confirmRemoteImport = async () => {
    const target = pendingRemoteImport;
    if (!target || remoteImportBusy) return;
    if (protectedWorkReasonRef.current) {
      setLastSyncState({ status: 'クラウド読み込みは作業終了後に確認します', error: '' });
      return;
    }

    const settings = getAutoSyncSettings();
    if (!settings.enabled || settings.syncId !== target.syncId) {
      setPendingRemoteImport(null);
      promptedRemoteUpdatedAtRef.current = '';
      setLastSyncState({ status: '同期設定が変わったため読み込みを中止しました', error: '' });
      return;
    }
    setRemoteImportBusy(true);
    setLastSyncState({ status: 'クラウドから読み込み中...', error: '' });

    const download = await downloadSyncData(target.syncId);
    const settingsAfterDownload = getAutoSyncSettings();
    if (!settingsAfterDownload.enabled || settingsAfterDownload.syncId !== target.syncId) {
      setPendingRemoteImport(null);
      promptedRemoteUpdatedAtRef.current = '';
      setRemoteImportBusy(false);
      return;
    }
    if (!download.ok) {
      if (download.code !== 'authentication_required') console.warn('Auto sync download failed.', download.error);
      setLastSyncState({
        status: download.code === 'authentication_required' ? '自動同期: ログインが必要です' : 'クラウド読み込み失敗',
        error: download.error,
      });
      promptedRemoteUpdatedAtRef.current = '';
      setPendingRemoteImport(null);
      setRemoteImportBusy(false);
      return;
    }
    if (!download.value) {
      setLastSyncState({ status: 'クラウドデータが見つかりません', error: '' });
      setPendingRemoteImport(null);
      setRemoteImportBusy(false);
      return;
    }

    if (protectedWorkReasonRef.current) {
      setLastSyncState({ status: 'クラウド読み込みは作業終了後に確認します', error: '' });
      setRemoteImportBusy(false);
      return;
    }

    const latestSettings = getAutoSyncSettings();
    if (!latestSettings.enabled || latestSettings.syncId !== target.syncId) {
      setPendingRemoteImport(null);
      promptedRemoteUpdatedAtRef.current = '';
      setRemoteImportBusy(false);
      setLastSyncState({ status: '同期設定が変わったため読み込みを中止しました', error: '' });
      return;
    }

    if (download.value.updatedAt !== target.updatedAt) {
      setLastSyncState({ status: '確認中にクラウドが更新されました。同期画面で確認してください', error: '' });
      setPendingRemoteImport(null);
      promptedRemoteUpdatedAtRef.current = '';
      setRemoteImportBusy(false);
      return;
    }
    const imported = await importQuizMakeData(download.value.payload, {
      expectedSyncId: target.syncId,
      authoritativeUpdatedAt: download.value.updatedAt,
      expectedLocalHash: target.localHash,
    });
    if (!imported.ok) {
      setLastSyncState({ status: 'クラウド読み込み失敗', error: imported.error });
      promptedRemoteUpdatedAtRef.current = '';
      setPendingRemoteImport(null);
      setRemoteImportBusy(false);
      return;
    }
    const settingsAfterImport = getAutoSyncSettings();
    if (!settingsAfterImport.enabled || settingsAfterImport.syncId !== target.syncId) {
      setPendingRemoteImport(null);
      promptedRemoteUpdatedAtRef.current = '';
      setRemoteImportBusy(false);
      return;
    }
    if (!setLastSyncStateForConnection(target.syncId, {
      lastSyncAt: download.value.updatedAt,
      lastRemoteUpdatedAt: download.value.updatedAt,
      lastUploadHash: computePayloadHash(download.value.payload),
      status: 'クラウドから読み込みました',
      error: '',
    })) {
      setPendingRemoteImport(null);
      promptedRemoteUpdatedAtRef.current = '';
      setRemoteImportBusy(false);
      return;
    }
    window.setTimeout(() => window.location.reload(), 700);
  };

  useEffect(() => {
    if (!pendingRemoteImport || !protectedWorkReason) return;
    setLastSyncState({ status: 'クラウドに新しいデータがあります（作業終了後に確認）', error: '' });
  }, [pendingRemoteImport, protectedWorkReason]);

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
        const promptKey = `${settings.syncId}:${meta.value.updatedAt}`;
        if (promptedRemoteUpdatedAtRef.current === promptKey) return;

        promptedRemoteUpdatedAtRef.current = promptKey;
        setLastSyncState({ status: 'クラウドに新しいデータがあります', error: '' });
        const localHash = computePayloadHash(await exportQuizMakeData());
        setPendingRemoteImport({ syncId: settings.syncId, updatedAt: meta.value.updatedAt, localHash });
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

  return (
    <ConfirmDialog
      fullPage
      open={pendingRemoteImport !== null && protectedWorkReason === null}
      title={'クラウドに新しいデータがあります'}
      message={'残す：クラウド\n上書き：この端末\n\n復元用バックアップを作成・読み戻し確認してから上書きします。'}
      confirmLabel={remoteImportBusy ? '読み込み中…' : 'バックアップして端末を上書き'}
      busy={remoteImportBusy}
      onCancel={cancelRemoteImport}
      onConfirm={() => void confirmRemoteImport()}
    />
  );
}
