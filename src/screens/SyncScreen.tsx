import { accountLocalStorage as localStorage, accountStorageEventKey } from '../utils/accountStorage';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { SyncScreenPage } from '../types';
import { SyncStatus } from '../components/SyncStatus';
import { requestSyncRetry } from '../utils/syncRequest';
import { setSyncInteractionProtected } from '../utils/syncInteraction';
import { SyncComparison } from '../components/SyncComparison';
import { saveBackupPayload } from '../utils/backupRepository';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, SyncIcon, UploadIcon } from '../components/UiIcons';
import {
  computePayloadHash,
  createSyncPairingCode,
  deleteRemoteSyncData,
  downloadSyncData,
  refreshDownloadedSyncData,
  exportQuizMakeData,
  exportQuizMakeRecoveryData,
  generateSyncId,
  getAutoSyncSettings,
  getLastSyncState,
  getRemoteSyncMeta,
  getPendingLegacySyncCompletion,
  getPendingLegacySyncUpgrade,
  getStoredSyncId,
  getSyncEnvironmentStatus,
  importQuizMakeData,
  isValidPairingCode,
  isSyncConfigured,
  normalizePairingCode,
  redeemSyncPairingCode,
  resumePendingLegacySyncUpgrade,
  runSyncDiagnostic,
  clearPendingLegacySyncCompletion,
  SYNC_ID_STORAGE_KEY,
  setAutoSyncEnabled,
  setLastSyncStateForConnection,
  setStoredSyncId,
  summarizeSyncPayload,
  uploadSyncData,
  upgradeLegacySyncId,
  type LastSyncState,
  type SyncPairingCode,
  type SyncDiagnosticResult,
  type SyncPayload,
  type SyncPayloadSummary,
} from '../utils/syncService';
import { isStrongSyncId } from '../utils/syncState';
import { saveJsonBackup, writeClipboardText } from '../utils/nativePlatform';
import { getCloudSession, onCloudSessionSnapshot, sendMagicLink } from '../utils/cloudService';
import { LineLoginButton } from '../components/LineLoginButton';
import { RecordConflictPanel } from '../components/RecordConflictPanel';
import { isRecordSyncOptedIn, setRecordSyncOptIn } from '../utils/recordSyncOptIn';
import './SyncScreen.css';

interface SyncScreenProps {
  onBack: () => void;
  page?: SyncScreenPage;
  onNavigatePage?: (page: SyncScreenPage) => void;
  onExitGuardChange?: (guard: (() => boolean) | null) => void;
  onImported?: () => Promise<void>;
  onProtectionChange?: (value: boolean) => void;
  onOpenBackups?: () => void;
}

export function SyncScreen({ onBack, onImported, onProtectionChange, onOpenBackups, page, onNavigatePage, onExitGuardChange }: SyncScreenProps) {
  const configured = useMemo(() => isSyncConfigured(), []);
  const environmentStatus = useMemo(() => getSyncEnvironmentStatus(), []);
  const [syncId, setSyncId] = useState(() => getStoredSyncId());
  const [activeSyncId, setActiveSyncId] = useState(() => getStoredSyncId().trim());
  const [autoEnabled, setAutoEnabledState] = useState(() => getAutoSyncSettings().enabled);
  const [recordSyncOptedIn, setRecordSyncOptedInState] = useState(() => isRecordSyncOptedIn(getStoredSyncId().trim()));
  const [lastState, setLastState] = useState<LastSyncState>(() => getLastSyncState());
  const [busy, setBusy] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [localPage, setLocalPage] = useState<SyncScreenPage>();
  const currentPage = page ?? localPage;
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<SyncDiagnosticResult | null>(null);
  const [storageUsage, setStorageUsage] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [cloudAccount, setCloudAccount] = useState<{ id: string; label: string } | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginRequested, setLoginRequested] = useState(false);
  const [pendingCloudDelete, setPendingCloudDelete] = useState<{
    syncId: string;
    expectedUpdatedAt: string | null;
  } | null>(null);
  const [pendingGeneratedSyncId, setPendingGeneratedSyncId] = useState('');
  const [pendingConnectSyncId, setPendingConnectSyncId] = useState('');
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [issuedPairingCode, setIssuedPairingCode] = useState<SyncPairingCode | null>(null);
  const [pendingCloudImport, setPendingCloudImport] = useState<{
    syncId: string;
    payload: SyncPayload;
    summary: SyncPayloadSummary;
    remoteUpdatedAt: string;
    localHash: string;
  } | null>(null);
  const [pendingCloudOverwrite, setPendingCloudOverwrite] = useState<{
    syncId: string;
    payload: SyncPayload;
    localHash: string;
    summary: SyncPayloadSummary;
    expectedRemoteUpdatedAt: string;
  } | null>(null);

  const interactionProtected = busy || childBusy || diagnosticBusy || loginBusy || reviewOpen || replacementOpen || syncId.trim() !== activeSyncId || Boolean(pairingCodeInput || issuedPairingCode) || Boolean(pendingCloudImport || pendingCloudOverwrite || pendingCloudDelete || pendingGeneratedSyncId || pendingConnectSyncId);
  useLayoutEffect(() => {
    setSyncInteractionProtected(interactionProtected);
    onProtectionChange?.(interactionProtected);
    return () => { setSyncInteractionProtected(false); onProtectionChange?.(false); };
  }, [interactionProtected, onProtectionChange]);
  useEffect(() => { setReviewOpen(false); }, [activeSyncId, cloudAccount?.id]);

  const normalizedSyncId = syncId.trim();
  const syncIdValid = isStrongSyncId(normalizedSyncId);
  const syncIdConnected = syncIdValid && normalizedSyncId === activeSyncId;
  const hasStrongConnection = isStrongSyncId(activeSyncId);
  const hasLegacyConnection = Boolean(activeSyncId) && !hasStrongConnection;
  const pairingCodeValid = isValidPairingCode(pairingCodeInput);
  const authenticated = cloudAccount !== null;
  const canRun = configured && authenticated && syncIdConnected && !busy;
  const autoCanRun = autoEnabled && configured && authenticated && syncIdConnected;

  useEffect(() => {
    let cancelled = false;
    const applySession = (session: Awaited<ReturnType<typeof getCloudSession>>) => {
      if (cancelled) return;
      const user = session?.user;
      setCloudAccount(user && !user.is_anonymous
        ? { id: user.id, label: user.email ?? user.phone ?? 'ログイン中' }
        : null);
      setAuthReady(true);
    };

    const unsubscribe = onCloudSessionSnapshot(applySession);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshSyncState = () => {
      setLastState(getLastSyncState());
      setAutoEnabledState(getAutoSyncSettings().enabled);
      setRecordSyncOptedInState(isRecordSyncOptedIn(getStoredSyncId().trim()));
    };
    const refreshExternalSyncState = (event: StorageEvent) => {
      const key = accountStorageEventKey(event);
      if (key === undefined || key !== null && !key.startsWith('quizMake:sync:')) return;
      refreshSyncState();
      if (key !== null && key !== SYNC_ID_STORAGE_KEY) return;

      const nextSyncId = getStoredSyncId().trim();
      setSyncId(nextSyncId);
      setActiveSyncId(nextSyncId);
      setPendingGeneratedSyncId('');
      setPendingConnectSyncId('');
      setIssuedPairingCode(null);
      setPendingCloudImport(null);
      setPendingCloudOverwrite(null);
      setPendingCloudDelete(null);
      setDiagnosticResult(null);
      setError('');
      setMessage(nextSyncId
        ? '別のタブで同期接続が変更されたため、表示を更新しました。'
        : '別のタブで同期接続が解除されたため、表示を更新しました。');
    };

    window.addEventListener('quiz-make-sync-state-change', refreshSyncState);
    window.addEventListener('quiz-make-sync-settings-change', refreshSyncState);
    window.addEventListener('storage', refreshExternalSyncState);
    const completedLegacyUpgrade = getPendingLegacySyncCompletion();
    if (completedLegacyUpgrade) {
      if (completedLegacyUpgrade.syncId === getStoredSyncId().trim()) {
        clearPendingLegacySyncCompletion(completedLegacyUpgrade.syncId);
      } else {
        setPendingConnectSyncId(completedLegacyUpgrade.syncId);
        setMessage('完了済みの旧ID移行があります。移行先へ切り替えるか確認してください。');
      }
    } else if (getPendingLegacySyncUpgrade()) {
      setBusy(true);
      setMessage('前回中断した旧ID移行を確認しています...');
      setError('');
      void resumePendingLegacySyncUpgrade().then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setMessage('');
          setError(`${result.error} 保留中の移行情報は残しているため、次回表示時に再確認できます。`);
          return;
        }
        if (!result.value) return;
        if (result.value.requiresConnectionConfirmation) {
          setPendingConnectSyncId(result.value.syncId);
          setMessage('前回中断した旧ID移行が完了しました。現在の同期先は変更せず、移行先への切り替えを確認します。');
          return;
        }
        if (getStoredSyncId().trim() !== result.value.syncId) {
          setPendingConnectSyncId(result.value.syncId);
          setMessage('移行完了後に同期先が変更されたため、現在の接続は変更せず移行先への切り替えを確認します。');
          return;
        }

        setSyncId(result.value.syncId);
        setActiveSyncId(result.value.syncId);
        const autoDisableResult = setAutoSyncEnabled(false);
        setAutoEnabledState(autoDisableResult.ok ? false : getAutoSyncSettings().enabled);
        if (!setLastSyncStateForConnection(result.value.syncId, {
          lastSyncAt: result.value.updatedAt,
          lastRemoteUpdatedAt: result.value.updatedAt,
          lastUploadHash: '',
          status: '旧同期IDを移行しました',
          error: '',
        })) {
          const currentSyncId = getStoredSyncId().trim();
          setSyncId(currentSyncId);
          setActiveSyncId(currentSyncId);
          if (currentSyncId !== result.value.syncId) {
            setPendingConnectSyncId(result.value.syncId);
            setMessage('同期状態の更新中に接続が変更されたため、移行先への切り替えを確認します。');
          } else {
            setMessage('');
            setError('旧IDの移行は完了しましたが、同期状態を端末に保存できませんでした。画面を開き直して確認してください。');
          }
          return;
        }
        setLastState(getLastSyncState());
        setMessage('前回中断した旧ID移行を完了しました。自動同期は確認後にONにしてください。');
        if (!autoDisableResult.ok) {
          setError(`旧IDの移行は完了しましたが、自動同期設定を端末へ保存できませんでした: ${autoDisableResult.error}`);
        }
      }).finally(() => {
        if (!cancelled) setBusy(false);
      });
    }
    return () => {
      cancelled = true;
      window.removeEventListener('quiz-make-sync-state-change', refreshSyncState);
      window.removeEventListener('quiz-make-sync-settings-change', refreshSyncState);
      window.removeEventListener('storage', refreshExternalSyncState);
    };
  }, []);

  const handleSendLoginLink = async () => {
    const normalizedEmail = loginEmail.trim();
    if (!normalizedEmail || loginBusy) return;
    setLoginBusy(true);
    setMessage('');
    setError('');
    try {
      await sendMagicLink(normalizedEmail, { name: 'sync', ...(currentPage ? { page: currentPage } : {}) });
      setMessage('ログイン用リンクを送信しました。メールのリンクを開くと、この画面へ戻ります。');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'ログイン用リンクを送信できませんでした。');
    } finally {
      setLoginBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const updateStorageUsage = async () => {
      if (!navigator.storage?.estimate) return;
      try {
        const estimate = await navigator.storage.estimate();
        if (cancelled || !estimate.usage || !estimate.quota) return;
        setStorageUsage(`${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`);
      } catch {
        // Storage estimate is optional.
      }
    };
    void updateStorageUsage();
    return () => {
      cancelled = true;
    };
  }, [message, error]);

  const updateSyncIdDraft = (value: string) => {
    setSyncId(value); setMessage(''); setError('');
  };

  const applyConnectedSyncId = (nextId: string): boolean => {
    const normalizedNextId = nextId.trim();
    if (!isStrongSyncId(normalizedNextId)) {
      setMessage('');
      setError('同期IDは「新しいIDを作る」で作成した36文字のIDを使用してください。');
      return false;
    }
    const shouldDisableAutoSync = autoEnabled && normalizedNextId !== activeSyncId;
    if (shouldDisableAutoSync) {
      const autoResult = setAutoSyncEnabled(false);
      if (!autoResult.ok) {
        setMessage('');
        setError(`同期先を変更する前に自動同期を停止できませんでした: ${autoResult.error}`);
        return false;
      }
      setAutoEnabledState(false);
    }

    const persistResult = setStoredSyncId(normalizedNextId);
    if (!persistResult.ok) {
      setPendingConnectSyncId('');
      setMessage('');
      setError(persistResult.error);
      setLastState(getLastSyncState());
      return false;
    }

    clearPendingLegacySyncCompletion(normalizedNextId);
    setSyncId(normalizedNextId);
    setActiveSyncId(normalizedNextId);
    setPendingConnectSyncId('');
    setIssuedPairingCode(null);
    setLastState(getLastSyncState());
    setError('');
    setMessage(shouldDisableAutoSync
      ? '同期IDへ接続しました。誤った自動送信を防ぐため、自動同期はOFFにしました。'
      : '同期IDへ接続しました。');
    return true;
  };

  const handleConnectSyncId = () => {
    if (!syncIdValid || normalizedSyncId === activeSyncId) return;
    if (activeSyncId) {
      setPendingConnectSyncId(normalizedSyncId);
      return;
    }
    applyConnectedSyncId(normalizedSyncId);
  };

  const handleGenerate = () => {
    try {
      const nextId = generateSyncId();
      if (activeSyncId) {
        setPendingGeneratedSyncId(nextId);
        return;
      }
      applyGeneratedSyncId(nextId);
    } catch {
      setMessage('');
      setError('この端末では安全な同期IDを生成できません。OSまたはブラウザを更新してください。');
    }
  };

  const applyGeneratedSyncId = (nextId: string) => {
    const connected = applyConnectedSyncId(nextId);
    setPendingGeneratedSyncId('');
    if (!connected) return;
    setMessage('同期を開始しました。まず、この端末のデータをクラウドへ保存してください。');
  };

  const handleCopySyncId = async () => {
    if (!normalizedSyncId) {
      setMessage('');
      setError('先に同期IDを生成または入力してください。');
      return;
    }
    try {
      await writeClipboardText(normalizedSyncId);
      setError('');
      setMessage('同期IDをクリップボードへコピーしました。');
    } catch {
      setMessage('');
      setError('同期IDをコピーできませんでした。入力欄を長押ししてコピーしてください。');
    }
  };

  const handlePairingCodeInput = (value: string) => {
    setPairingCodeInput(normalizePairingCode(value).slice(0, 8));
    setMessage('');
    setError('');
  };

  const handleIssuePairingCode = async () => {
    if (!hasStrongConnection || busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await createSyncPairingCode(activeSyncId);
      if (!result.ok) {
        setIssuedPairingCode(null);
        setError(result.error);
        return;
      }
      setIssuedPairingCode(result.value);
      setMessage('接続コードを発行しました。5分以内に、もう一方の端末へ入力してください。');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyPairingCode = async () => {
    if (!issuedPairingCode) return;
    try {
      await writeClipboardText(issuedPairingCode.code);
      setError('');
      setMessage('8文字の接続コードをコピーしました。');
    } catch {
      setMessage('');
      setError('接続コードをコピーできませんでした。コードを長押ししてコピーしてください。');
    }
  };

  const handleRedeemPairingCode = async () => {
    if (!pairingCodeValid || busy) return;
    const connectionAtStart = getStoredSyncId().trim();
    setBusy(true);
    setMessage('接続コードを確認しています...');
    setError('');
    try {
      const result = await redeemSyncPairingCode(pairingCodeInput);
      if (!result.ok) {
        setMessage('');
        setError(result.error);
        return;
      }
      const currentConnection = getStoredSyncId().trim();
      if (currentConnection !== connectionAtStart) {
        setPairingCodeInput('');
        if (result.value === currentConnection) {
          setSyncId(currentConnection);
          setActiveSyncId(currentConnection);
          setMessage('接続コードの確認中に別のタブで同じ接続が設定されました。表示を更新しました。');
          return;
        }
        setPendingConnectSyncId(result.value);
        setMessage('接続コードの確認中に別のタブで同期先が変更されました。接続先の変更を確認してください。');
        return;
      }
      if (currentConnection && result.value !== currentConnection) {
        setPairingCodeInput('');
        setPendingConnectSyncId(result.value);
        setMessage('接続コードを確認しました。同期先の変更を確認してください。');
        return;
      }
      const connected = applyConnectedSyncId(result.value);
      setPairingCodeInput('');
      if (!connected) {
        // The one-time code was redeemed successfully. Keep its resolved sync
        // ID as an unconnected draft so the user can retry local persistence.
        setSyncId(result.value);
        return;
      }
      setMessage('別の端末へ接続しました。「バックアップと復旧」の同期の復旧で内容を確認できます。');
    } finally {
      setBusy(false);
    }
  };

  const handleUpgradeLegacySyncId = async () => {
    if (!hasLegacyConnection || busy) return;
    const expectedUpdatedAt = lastState.lastSyncAt || lastState.lastRemoteUpdatedAt;
    setBusy(true);
    setMessage('旧同期IDを安全な接続へ移行しています...');
    setError('');
    try {
      const result = await upgradeLegacySyncId(activeSyncId, expectedUpdatedAt);
      if (!result.ok) {
        setMessage('');
        setError(result.error);
        return;
      }
      if (result.value.requiresConnectionConfirmation) {
        setPendingConnectSyncId(result.value.syncId);
        setMessage('移行中に別のタブで同期先が変更されました。移行済みの接続へ切り替えるか確認してください。');
        return;
      }
      if (getStoredSyncId().trim() !== result.value.syncId) {
        setPendingConnectSyncId(result.value.syncId);
        setMessage('移行完了後に別のタブで同期先が変更されました。現在の接続は変更せず、移行先へ切り替えるか確認してください。');
        return;
      }
      setSyncId(result.value.syncId);
      setActiveSyncId(result.value.syncId);
      const autoDisableResult = setAutoSyncEnabled(false);
      setAutoEnabledState(autoDisableResult.ok ? false : getAutoSyncSettings().enabled);
      if (!setLastSyncStateForConnection(result.value.syncId, {
        lastSyncAt: result.value.updatedAt,
        lastRemoteUpdatedAt: result.value.updatedAt,
        lastUploadHash: '',
        status: '旧同期IDを移行しました',
        error: '',
      })) {
        const currentSyncId = getStoredSyncId().trim();
        setSyncId(currentSyncId);
        setActiveSyncId(currentSyncId);
        if (currentSyncId !== result.value.syncId) {
          setPendingConnectSyncId(result.value.syncId);
          setMessage('同期状態を更新する直前に接続が変更されたため、移行先へ切り替えるか確認してください。');
        } else {
          setMessage('');
          setError('旧IDの移行は完了しましたが、同期状態を端末に保存できませんでした。画面を開き直して確認してください。');
        }
        return;
      }
      setLastState(getLastSyncState());
      setMessage('旧同期IDを安全な接続へ移行しました。自動同期は確認後にONにしてください。');
      if (!autoDisableResult.ok) {
        setError(`旧IDの移行は完了しましたが、自動同期設定を端末へ保存できませんでした: ${autoDisableResult.error}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAutoSync = () => {
    setMessage('');
    setError('');

    if (!autoEnabled && (!configured || !syncIdConnected)) {
      setError('自動同期をONにする前に、同期IDを入力して「このIDに接続」を押してください。');
      return;
    }

    const result = setAutoSyncEnabled(!autoEnabled);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setAutoEnabledState(result.value);
    setLastState(getLastSyncState());
    setMessage(result.value ? '自動同期をONにしました。' : '自動同期をOFFにしました。');
  };

  const handleToggleRecordSync = async () => {
    setMessage('');
    setError('');
    if (recordSyncOptedIn) {
      const result = setRecordSyncOptIn(activeSyncId, false);
      if (!result.ok) { setError(result.error); return; }
      setRecordSyncOptedInState(false);
      setMessage('変更ごとの同期をOFFにしました。全体コピー同期へ戻ります。');
      return;
    }
    if (!autoCanRun || busy) {
      setError('変更ごとの同期を始めるには、ログインと同期接続を確認し、自動同期をONにしてください。');
      return;
    }
    setBusy(true);
    try {
      const payload = await exportQuizMakeRecoveryData();
      await saveJsonBackup(`quiz-make-backup-${formatBackupFileDate(new Date())}.json`, JSON.stringify(payload, null, 2));
      const current = getAutoSyncSettings();
      const session = await getCloudSession();
      if (!current.enabled || current.syncId.trim() !== activeSyncId || session?.user.id !== cloudAccount?.id) {
        throw new Error('バックアップ作成中に同期接続が変わりました。');
      }
      const result = setRecordSyncOptIn(activeSyncId, true);
      if (!result.ok) throw new Error(result.error);
      setRecordSyncOptedInState(true);
      setMessage('JSONバックアップを作成し、この端末で変更ごとの同期をONにしました。');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '変更ごとの同期をONにできませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadBackup = async () => {
    try {
      const payload = await exportQuizMakeRecoveryData();
      await saveJsonBackup(`quiz-make-backup-${formatBackupFileDate(new Date())}.json`, JSON.stringify(payload, null, 2));
      setError('');
      setMessage('現在データのJSONバックアップを作成しました。');
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setMessage('');
      setError(`JSONバックアップの作成に失敗しました: ${detail}`);
    }
  };

  const prepareDeleteCloudData = async () => {
    if (!syncIdValid || busy) return;
    const operationSyncId = normalizedSyncId;
    setBusy(true);
    setMessage('クラウドの最新状態を確認しています...');
    setError('');
    try {
      const meta = await getRemoteSyncMeta(operationSyncId);
      if (!meta.ok) {
        setMessage('');
        setError(meta.error);
        return;
      }
      if (getStoredSyncId().trim() !== operationSyncId) {
        setMessage('');
        setError('確認中に別のタブで同期接続が変更されたため、削除を中止しました。');
        return;
      }
      setPendingCloudDelete({
        syncId: operationSyncId,
        expectedUpdatedAt: meta.value?.updatedAt ?? null,
      });
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteCloudData = async () => {
    const target = pendingCloudDelete;
    if (!target || busy) return;
    if (getStoredSyncId().trim() !== target.syncId) {
      setPendingCloudDelete(null);
      setMessage('');
      setError('同期接続が変更されたため、削除を中止しました。');
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = target.expectedUpdatedAt
        ? await deleteRemoteSyncData(target.syncId, target.expectedUpdatedAt)
        : { ok: true as const, value: false };
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (getStoredSyncId().trim() !== target.syncId) {
        setPendingCloudDelete(null);
        setMessage('');
        setError('削除中に別のタブで同期接続が変更されたため、現在の接続は解除していません。');
        return;
      }
      const autoDisableResult = setAutoSyncEnabled(false);
      if (getStoredSyncId().trim() !== target.syncId) {
        setPendingCloudDelete(null);
        setMessage('');
        setError('削除完了直後に同期接続が変更されたため、現在の接続は解除していません。');
        return;
      }
      const disconnectResult = setStoredSyncId('');
      if (!disconnectResult.ok) {
        setPendingCloudDelete(null);
        setAutoEnabledState(getAutoSyncSettings().enabled);
        setLastState(getLastSyncState());
        setMessage('');
        setError(`クラウドデータは削除しましたが、この端末の同期接続を解除できませんでした: ${disconnectResult.error}`);
        return;
      }
      setSyncId('');
      setActiveSyncId('');
      setIssuedPairingCode(null);
      setAutoEnabledState(autoDisableResult.ok ? false : getAutoSyncSettings().enabled);
      setLastState(getLastSyncState());
      setMessage(result.value
        ? 'クラウド上の同期データを削除し、この端末の同期接続を解除しました。端末内のデータは残っています。'
        : 'クラウドデータは見つかりませんでした。この端末の古い同期接続を解除しました。');
      if (!autoDisableResult.ok) {
        setError(`同期接続は解除しましたが、自動同期設定を端末へ保存できませんでした: ${autoDisableResult.error}`);
      }
      setPendingCloudDelete(null);
    } finally {
      setBusy(false);
    }
  };



  const uploadAndVerify = async (
    operationSyncId: string,
    payload: SyncPayload,
    localHash: string,
    localSummary: SyncPayloadSummary,
    force: boolean,
    confirmedRemoteUpdatedAt?: string,
  ) => {
    const syncState = getLastSyncState();
    const result = await uploadSyncData(operationSyncId, payload, {
      // Only a completed upload/import is a safe base for overwriting. Merely
      // viewing a newer cloud version must not turn it into an accepted base.
      expectedRemoteUpdatedAt: (confirmedRemoteUpdatedAt ?? syncState.lastSyncAt) || null,
      force,
    });
    if (!result.ok) {
      setLastState(getLastSyncState());
      setMessage('');
      if (result.code === 'conflict' && !force) {
        if (!result.remoteUpdatedAt) {
          setError('クラウド側の確認対象を特定できないため、上書き確認を開始できません。先にクラウドの保存データを確認してください。');
          return;
        }
        setError('');
        setPendingCloudOverwrite({
          syncId: operationSyncId,
          payload,
          localHash,
          summary: localSummary,
          expectedRemoteUpdatedAt: result.remoteUpdatedAt,
        });
        return;
      }
      setError(result.error);
      return;
    }

    if (result.value.localChangesPending) {
      setLastState(getLastSyncState());
      setMessage('保存中に端末データが更新されました。最新の内容でもう一度「クラウドへ保存」を押してください。');
      setError('');
      return;
    }

    const verify = await refreshDownloadedSyncData(result.value);
    setLastState(getLastSyncState());

    if (!verify.ok) {
      setMessage('');
      setError(`保存後の読み戻し確認に失敗しました: ${verify.error}`);
      return;
    }
    if (!verify.value) {
      setMessage('');
      setError('保存後にクラウドデータを読み戻せませんでした。同じ同期IDのデータが見つかりません。');
      return;
    }

    const remoteHash = computePayloadHash(verify.value.payload);
    const remoteSummary = summarizeSyncPayload(verify.value.payload);
    if (remoteHash !== localHash) {
      setMessage('');
      setError(`保存後の読み戻し内容が一致しません。ローカル: ${formatSyncSummary(localSummary)} / クラウド: ${formatSyncSummary(remoteSummary)}`);
      return;
    }

    setMessage(`クラウドへ保存しました。更新: ${formatDateTime(verify.value.updatedAt)} / ${formatSyncSummary(remoteSummary)}`);
  };

  const handleUpload = async (preparedPayload?: SyncPayload, confirmedRemoteUpdatedAt?: string) => {
    if (!configured) {
      setError('クラウド同期の接続設定が完了していません。');
      return;
    }
    if (!normalizedSyncId) {
      setError('同期IDを入力してください。');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('クラウドへ保存しています...');

    try {
      const operationSyncId = normalizedSyncId;
      const payload = preparedPayload ?? await exportQuizMakeData();
      const localHash = computePayloadHash(payload);
      const localSummary = summarizeSyncPayload(payload);
      await uploadAndVerify(operationSyncId, payload, localHash, localSummary, Boolean(preparedPayload && confirmedRemoteUpdatedAt), confirmedRemoteUpdatedAt);
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setMessage('');
      setError(`クラウドへの保存準備に失敗しました: ${detail}`);
    } finally {
      setBusy(false);
      setLastState(getLastSyncState());
    }
  };

  const cancelCloudOverwrite = () => {
    setPendingCloudOverwrite(null);
    setMessage('クラウドへの上書きをキャンセルしました。');
  };

  const confirmCloudOverwrite = async () => {
    const target = pendingCloudOverwrite;
    if (!target) return;
    if (getStoredSyncId().trim() !== target.syncId) {
      setPendingCloudOverwrite(null);
      setMessage('');
      setError('同期接続が変更されたため、以前の接続への上書きを中止しました。');
      return;
    }
    setPendingCloudOverwrite(null);
    setBusy(true);
    setError('');
    setMessage('確認済みの内容でクラウドを上書きしています...');
    try {
      const [latestLocal, latestRemote] = await Promise.all([exportQuizMakeData(), downloadSyncData(target.syncId)]);
      if (!latestRemote.ok) throw new Error(latestRemote.error);
      if (computePayloadHash(latestLocal) !== target.localHash || latestRemote.value?.updatedAt !== target.expectedRemoteUpdatedAt) {
        throw new Error('確認中に内容が更新されました。同期状態を確認し直してください。');
      }
      await saveBackupPayload(latestLocal, 'before-sync');
      await saveBackupPayload(latestRemote.value.payload, 'before-sync');
      await uploadAndVerify(
        target.syncId,
        target.payload,
        target.localHash,
        target.summary,
        true,
        target.expectedRemoteUpdatedAt,
      );
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setMessage('');
      setError(`クラウドへの上書きに失敗しました: ${detail}`);
    } finally {
      setBusy(false);
      setLastState(getLastSyncState());
    }
  };

  const handleDownload = async () => {
    if (!configured) {
      setError('クラウド同期の接続設定が完了していません。');
      return;
    }
    if (!normalizedSyncId) {
      setError('同期IDを入力してください。');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('クラウドから読み込んでいます...');

    const operationSyncId = normalizedSyncId;
    const result = await downloadSyncData(operationSyncId);
    setBusy(false);
    setLastState(getLastSyncState());

    if (!result.ok) {
      setMessage('');
      setError(result.error);
      return;
    }

    if (!result.value) {
      setMessage('');
      setError('この同期IDのデータが見つかりません。');
      return;
    }

    const remoteSummary = summarizeSyncPayload(result.value.payload);
    let localHash: string;
    try { localHash = computePayloadHash(await exportQuizMakeRecoveryData()); }
    catch { setMessage(''); setError('端末の状態を確認できないため、読み込みを中止しました。'); return; }
    setMessage('');
    setPendingCloudImport({
      syncId: operationSyncId,
      payload: result.value.payload,
      summary: remoteSummary,
      remoteUpdatedAt: result.value.updatedAt,
      localHash,
    });
  };

  const cancelCloudImport = () => {
    if (busy) return;
    setPendingCloudImport(null);
    setMessage('読み込みをキャンセルしました。');
  };

  const confirmCloudImport = async () => {
    const target = pendingCloudImport;
    if (!target || busy) return;
    if (getStoredSyncId().trim() !== target.syncId) {
      setPendingCloudImport(null);
      setMessage('');
      setError('同期接続が変更されたため、以前の接続からの読み込みを中止しました。');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('クラウドの最新状態を確認しています...');

    const latestRemote = await refreshDownloadedSyncData({ syncId: target.syncId, payload: target.payload, updatedAt: target.remoteUpdatedAt });
    if (!latestRemote.ok) {
      setBusy(false);
      setPendingCloudImport(null);
      setMessage('');
      setError(latestRemote.error);
      return;
    }
    if (!latestRemote.value) {
      setBusy(false);
      setPendingCloudImport(null);
      setMessage('');
      setError('確認中にクラウドデータが削除されたため、読み込みを中止しました。');
      return;
    }
    if (latestRemote.value.updatedAt !== target.remoteUpdatedAt) {
      const latestSummary = summarizeSyncPayload(latestRemote.value.payload);
      setBusy(false);
      setPendingCloudImport({
        syncId: target.syncId,
        payload: latestRemote.value.payload,
        summary: latestSummary,
        remoteUpdatedAt: latestRemote.value.updatedAt,
        localHash: target.localHash,
      });
      setMessage('確認中にクラウドデータが更新されたため、最新の内容に更新しました。内容を確認して、もう一度読み込んでください。');
      return;
    }
    setMessage('クラウドデータを反映しています...');

    const importResult = await importQuizMakeData(latestRemote.value.payload, {
      expectedSyncId: target.syncId,
      authoritativeUpdatedAt: latestRemote.value.updatedAt,
      expectedLocalHash: target.localHash,
    });
    setLastState(getLastSyncState());
    if (!importResult.ok) {
      setBusy(false);
      setPendingCloudImport(null);
      setMessage('');
      setError(importResult.error);
      return;
    }

    if (getStoredSyncId().trim() !== target.syncId) {
      setBusy(false);
      setPendingCloudImport(null);
      setMessage('');
      setError('読み込み中に同期接続が変更されました。読み込んだ内容を現在の接続の同期済みデータとしては扱いません。画面を再読み込みします。');
      window.setTimeout(() => window.location.reload(), 1200);
      return;
    }

    if (!setLastSyncStateForConnection(target.syncId, {
      status: 'クラウドから読み込みました',
      error: '',
    })) {
      setBusy(false);
      setPendingCloudImport(null);
      setMessage('');
      setError('読み込み完了時に同期接続が変更されたため、現在の接続の同期済みデータとしては扱いません。画面を再読み込みします。');
      window.setTimeout(() => window.location.reload(), 1200);
      return;
    }
    setLastState(getLastSyncState());

    if (onImported) {
      try {
        await onImported();
        setPendingCloudImport(null);
        setBusy(false);
        setMessage(`クラウドから読み込みました。${formatSyncSummary(target.summary)}`);
      } catch {
        window.location.reload();
      }
    } else window.location.reload();
  };
  const handleDiagnostic = async () => {
    setDiagnosticBusy(true);
    setMessage('接続診断を実行しています...');
    setError('');

    try {
      const result = await runSyncDiagnostic(normalizedSyncId);
      setDiagnosticResult(result);
      setMessage(result.ok ? '基本接続の診断が完了しました。差分同期の成否は前回の失敗欄を確認してください。' : '基本接続の診断が完了しました。NG項目を確認してください。');
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setDiagnosticResult({
        ok: false,
        steps: [{ name: '接続診断', ok: false, message: '診断処理中にエラーが発生しました', errorDetails: detail }],
      });
      setMessage('');
      setError(`接続診断に失敗しました: ${detail}`);
    } finally {
      setDiagnosticBusy(false);
    }
  };

  const goToPage = (next: SyncScreenPage) => {
    if (busy || childBusy || diagnosticBusy || loginBusy || reviewOpen) return;
    setMessage(''); setError('');
    if (onNavigatePage) onNavigatePage(next);
    else { setSyncId(activeSyncId); setPairingCodeInput(''); setIssuedPairingCode(null); setReplacementOpen(false); setLocalPage(next); }
  };
  const canLeave = () => {
    if (busy || childBusy || diagnosticBusy || loginBusy) return false;
    if (reviewOpen) { setReviewOpen(false); return false; }
    if (pendingCloudImport || pendingCloudOverwrite || pendingCloudDelete || pendingGeneratedSyncId || pendingConnectSyncId) {
      setPendingCloudImport(null); setPendingCloudOverwrite(null); setPendingCloudDelete(null);
      setPendingGeneratedSyncId(''); setPendingConnectSyncId('');
      return false;
    }
    return true;
  };
  useLayoutEffect(() => {
    onExitGuardChange?.(canLeave);
    return () => onExitGuardChange?.(null);
  });
  const back = () => {
    if (!canLeave()) return;
    if (!onNavigatePage && currentPage) { setLocalPage(undefined); setSyncId(activeSyncId); setPairingCodeInput(''); setIssuedPairingCode(null); setReplacementOpen(false); }
    else onBack();
  };
  const pageTitle = currentPage === 'settings' ? '同期設定' : currentPage === 'recovery' ? '同期の復旧'
    : currentPage === 'connect' ? 'ほかの端末とつなぐ' : currentPage === 'diagnostics' ? '接続診断'
      : currentPage === 'danger' ? '接続とクラウドの管理' : '同期';
  const link = (target: SyncScreenPage, label: string) => <button type="button" className="sync-page-link"
    disabled={busy || childBusy || diagnosticBusy || loginBusy || reviewOpen} onClick={() => goToPage(target)}><span>{label}</span><ChevronRightIcon size={20} /></button>;
  const initialSyncRequired = hasStrongConnection && !recordSyncOptedIn && !lastState.lastSyncAt && !lastState.lastUploadHash;
  return (
    <div className="sync-screen sync-screen--simple" data-sync-page={currentPage ?? 'main'}>
      <header className="sync-screen__header">
        <BackButton onClick={back} label="戻る" className="sync-screen__back" disabled={busy || childBusy || diagnosticBusy || loginBusy} />
        <div className="sync-screen__header-text"><h1>{pageTitle}</h1></div>
      </header>
      <main className="sync-screen__body sync-screen__body--single">
        {!configured ? (
          <div className="sync-alert sync-alert--warning">
            現在、クラウド同期は利用できません。端末のデータはそのまま使えます。「バックアップと復旧」から端末データを保存できます。
          </div>
        ) : null}

        {configured && !authReady ? (
          <div className="sync-alert sync-alert--message" role="status">ログイン状態を確認しています…</div>
        ) : null}

        {configured && authReady && (!authenticated || loginRequested) ? (
          <section className="sync-auth-gate" aria-labelledby="sync-auth-title">
            <div>
              <h2 id="sync-auth-title">同期にはログインが必要です</h2>
            </div>
            <div className="sync-auth-gate__form">
              <LineLoginButton />
              <label htmlFor="sync-login-email">メールアドレス</label>
              <div>
                <input
                  id="sync-login-email"
                  className="sync-input"
                  type="email"
                  value={loginEmail}
                  autoComplete="email"
                  onChange={(event) => setLoginEmail(event.target.value)}
                />
                <button type="button" className="sync-button sync-button--primary" disabled={loginBusy || !loginEmail.trim()} onClick={() => void handleSendLoginLink()}>
                  {loginBusy ? '送信中…' : 'ログイン用リンクを送る'}
                </button>
              </div>
            </div>
          </section>
        ) : null}


        {message ? <div className="sync-alert sync-alert--message" role="status" aria-live="polite">{message}</div> : null}
        {error ? <div className="sync-alert sync-alert--error" role="alert">操作を完了できません。変更は端末に保持しています<details><summary>詳細</summary>{error}</details></div> : null}
        {!currentPage ? <>
          {configured && authenticated && hasStrongConnection ? <section className="sync-card sync-card--transfer">
            <SyncStatus onLogin={() => setLoginRequested(true)} syncId={activeSyncId} accountId={cloudAccount.id}
              recordEnabled={recordSyncOptedIn} autoEnabled={autoEnabled} lastState={lastState} disabled={interactionProtected}
              onInitialSync={initialSyncRequired ? () => goToPage('recovery') : undefined} />
            {recordSyncOptedIn ? <RecordConflictPanel syncId={activeSyncId} accountId={cloudAccount.id} onImported={onImported}
              open={reviewOpen} onOpenChange={setReviewOpen} onOpenBackups={onOpenBackups} onBusyChange={setChildBusy} /> : null}
          </section> : null}
          {hasLegacyConnection ? <div className="sync-alert sync-alert--warning">旧形式の接続があります。復旧画面で移行を確認できます。</div> : null}
          <nav className="sync-page-links" aria-label="同期の操作">
            {link(hasLegacyConnection ? 'recovery' : 'connect', hasLegacyConnection ? '旧形式の接続を確認' : hasStrongConnection ? 'ほかの端末とつなぐ' : '同期を始める')}
            {link('settings', '同期設定')}
            {onOpenBackups ? <button type="button" className="sync-page-link" disabled={interactionProtected} onClick={onOpenBackups}><span>バックアップと復旧</span><ChevronRightIcon size={20} /></button> : link('recovery', 'バックアップと復旧')}
          </nav>
        </> : null}
        {currentPage === 'settings' ? <>
          {configured && authenticated ? (
            <div className="sync-account-line" role="status">
              <span>ログイン中</span>
              <strong>{cloudAccount.label.length > 28 ? `${cloudAccount.label.slice(0, 25)}…` : cloudAccount.label}</strong>
            </div>
          ) : null}


          <section className="sync-advanced__section" aria-label="自動同期の設定">
            <div className="sync-auto-row">
              <div>
                <strong>自動同期</strong>
                <small>端末の変更を保存し、ホームでクラウドの更新を取り込みます。両方に変更があるときだけ確認します。</small>
                {autoEnabled && !autoCanRun ? <small>接続設定を確認してください</small> : null}
              </div>
              <button
                type="button"
                className={`sync-toggle__button${autoEnabled ? ' sync-toggle__button--active' : ''}`}
                onClick={handleToggleAutoSync}
                role="switch"
                aria-label="自動同期"
                aria-checked={autoEnabled}
                disabled={busy || (!autoEnabled && (!configured || !authenticated || !syncIdConnected))}
              >
                {autoEnabled ? 'ON' : 'OFF'}
              </button>
            </div>


          </section>
          <nav className="sync-page-links" aria-label="同期設定の操作">{link('danger', '接続とクラウドの管理')}</nav>
        </> : null}
        {currentPage === 'connect' ? <>
          {configured && authenticated ? (
            <div className="sync-account-line" role="status">
              <span>ログイン中</span>
              <strong>{cloudAccount.label.length > 28 ? `${cloudAccount.label.slice(0, 25)}…` : cloudAccount.label}</strong>
            </div>
          ) : null}


          {configured && authenticated ? <>
            {hasLegacyConnection ? <div className="sync-alert sync-alert--warning">旧形式の接続を復旧画面で確認してください。{link('recovery', '旧形式の接続を確認')}</div>
              : hasStrongConnection ? <section className="sync-advanced__section"><h2>この端末の接続を追加する</h2>
                <p className="sync-help">もう一方の端末でも同じアカウントでログインし、下のコードを入力します。</p>
                <button type="button" className="sync-button sync-button--secondary" onClick={() => void handleIssuePairingCode()} disabled={busy || !configured || !authenticated}>
                  接続コードを発行
                </button>
                {issuedPairingCode ? (
                  <div className="sync-pairing-code" role="status" aria-live="polite">
                    <span>接続コード</span>
                    <strong>{formatPairingCode(issuedPairingCode.code)}</strong>
                    <small>{formatDateTime(issuedPairingCode.expiresAt)}まで有効・1回だけ使用できます</small>
                    <button type="button" className="sync-button sync-button--secondary" onClick={() => void handleCopyPairingCode()} disabled={busy}>
                      <CopyIcon size={18} />
                      コードをコピー
                    </button>
                  </div>
                ) : null}

              </section> : <section className="sync-advanced__section">
                <button type="button" className="sync-start-button" onClick={handleGenerate} disabled={busy || !configured || !authenticated}>
                  <SyncIcon size={22} />
                  <span>
                    <strong>この端末から始める</strong><small>クラウドに保存する準備をします</small>
                  </span>
                </button>

              </section>}
            <section className="sync-advanced__section"><h2>{hasStrongConnection ? '別の接続を使う' : 'ほかの端末で使っている'}</h2>
              <label htmlFor="sync-pairing-code">接続コード</label>
              <div className="sync-pairing-join__controls">
                <input
                  id="sync-pairing-code"
                  className="sync-input sync-input--pairing"
                  value={pairingCodeInput}
                  onChange={(event) => handlePairingCodeInput(event.target.value)}
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={!authenticated}
                />
                <button type="button" className="sync-button sync-button--primary" onClick={() => void handleRedeemPairingCode()} disabled={busy || !configured || !authenticated || !pairingCodeValid}>
                  接続する
                </button>
              </div>
              <small>元の端末で発行したコードを5分以内に入力。接続後に、クラウドの内容を取り込むか確認できます。</small>

            </section>
            {initialSyncRequired ? link('recovery', '初回のデータを確認') : null}
          </> : null}
        </> : null}
        {currentPage === 'recovery' ? <>
          <p className="sync-help">同期先の変更やデータの置き換えが必要なときに使います。普段の同期には操作不要です。</p>
          {onOpenBackups ? null : <button type="button" className="sync-button sync-button--secondary" onClick={handleDownloadBackup} disabled={busy}><DownloadIcon size={18} />JSONバックアップを保存</button>}
          {hasLegacyConnection ? <div className="sync-legacy" role="status">
            <strong>旧形式の同期IDがあります</strong>
            <p>端末内のデータを残したまま、安全な接続へ移行できます。</p>
            <div className="sync-actions">
              <button type="button" className="sync-button sync-button--primary" onClick={() => void handleUpgradeLegacySyncId()} disabled={busy || !configured || !authenticated}>
                旧IDを安全に移行
              </button>
            </div>
          </div> : null}
          {configured && authenticated && hasStrongConnection && syncIdConnected && !recordSyncOptedIn ?
            <details className="sync-advanced" open={replacementOpen} onToggle={event => setReplacementOpen(event.currentTarget.open)}>
              <summary><strong>{initialSyncRequired ? '初回のデータを確認' : '全体のデータを置き換える'}</strong><ChevronDownIcon size={20} /></summary>
              {replacementOpen ? <div className="sync-advanced__body"><SyncComparison syncId={normalizedSyncId} disabled={!canRun} onUpload={handleUpload} onDownload={handleDownload} onBusyChange={setChildBusy}
                onRetry={() => { setReplacementOpen(false); window.setTimeout(() => requestSyncRetry(activeSyncId), 0); }} /></div> : null}
            </details> : null}
          <details className="sync-advanced" onToggle={event => { if (!event.currentTarget.open) setSyncId(activeSyncId); }}>
            <summary><strong>復旧用の同期ID</strong><ChevronDownIcon size={20} /></summary><div className="sync-advanced__body">
              <p>通常は8文字コードを使います。コードを発行できない場合にだけ、このIDを保管・入力してください。</p>
              <input
                className="sync-input sync-input--recovery"
                value={syncId}
                onChange={(event) => updateSyncIdDraft(event.target.value)}
                aria-label="復旧用の同期ID"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
              {normalizedSyncId && !syncIdValid ? (
                <p className="sync-card__error-text" role="alert">36文字の安全な同期IDではありません。</p>
              ) : null}
              {syncIdValid && !syncIdConnected ? (
                <p className="sync-card__compact-note">入力内容はまだ保存されていません。</p>
              ) : null}
              <div className="sync-actions">
                <button type="button" className="sync-button sync-button--primary" onClick={handleConnectSyncId} disabled={busy || !authenticated || !syncIdValid || syncIdConnected}>
                  {syncIdConnected ? '接続済み' : 'このIDへ接続'}
                </button>
                <button type="button" className="sync-button sync-button--secondary" onClick={() => void handleCopySyncId()} disabled={busy || !syncIdValid}>
                  <CopyIcon size={18} />
                  IDをコピー
                </button>
              </div>
            </div></details>


          <details className="sync-advanced"><summary><strong>同期方式の移行・復旧</strong><ChevronDownIcon size={20} /></summary><div className="sync-advanced__body">
            <p className="sync-help">使用中の方式：{recordSyncOptedIn ? '変更ごとの同期' : '全体コピー同期'}。変更前のバックアップと接続設定を確認します。</p>
            <div className="sync-auto-row">
              <div>
                <strong>変更ごとの同期（試験運用）</strong>
                <small>変更した問題・回答だけを送受信します。ONにする前に、この端末のJSONバックアップを保存します。</small>
                {!autoEnabled ? <small>自動同期をONにすると選べます。</small> : null}
              </div>
              <button
                type="button"
                className={`sync-toggle__button${recordSyncOptedIn ? ' sync-toggle__button--active' : ''}`}
                onClick={() => void handleToggleRecordSync()}
                role="switch"
                aria-label="変更ごとの同期"
                aria-checked={recordSyncOptedIn}
                disabled={busy || (!recordSyncOptedIn && !autoCanRun)}
              >
                {recordSyncOptedIn ? 'ON' : 'OFF'}
              </button>
            </div>



          </div></details>
          <nav className="sync-page-links" aria-label="復旧の操作">{link('diagnostics', '接続診断')}</nav>
        </> : null}
        {currentPage === 'diagnostics' ? <>
          {configured && authenticated && hasStrongConnection ? <SyncStatus detailsOpen diagnosticsOnly syncId={activeSyncId} accountId={cloudAccount.id}
            recordEnabled={recordSyncOptedIn} autoEnabled={autoEnabled} lastState={lastState} disabled={interactionProtected} onLogin={() => setLoginRequested(true)} /> : null}
          {storageUsage ? <p className="sync-help">端末ストレージ使用量：{storageUsage}</p> : null}
          <p className="sync-help">この診断は設定・端末の書き出し・全体コピー用RPCの読み込みを確認します。変更ごとの同期全体の正常性を保証するものではありません。</p>
          <section className="sync-advanced__section">
            <h2>接続診断</h2>
            <p>クラウドURL：{environmentStatus.hasUrl ? '設定済み' : '未設定'}／接続キー：{environmentStatus.hasAnonKey ? '設定済み' : '未設定'}</p>
            <button type="button" className="sync-button sync-button--secondary" onClick={handleDiagnostic} disabled={diagnosticBusy}>
              {diagnosticBusy ? '診断中...' : '接続を診断する'}
            </button>
            {diagnosticResult ? (
              <div className="sync-diagnostic" aria-live="polite">
                <div className={`sync-diagnostic__summary${diagnosticResult.ok ? ' sync-diagnostic__summary--ok' : ' sync-diagnostic__summary--ng'}`}>
                  同期診断結果：{diagnosticResult.ok ? 'OK' : 'NG'}
                </div>
                <div className="sync-diagnostic__steps">
                  {diagnosticResult.steps.map((step) => (
                    <div key={step.name} className={`sync-diagnostic__step${step.ok ? ' sync-diagnostic__step--ok' : ' sync-diagnostic__step--ng'}`}>
                      <div className="sync-diagnostic__step-head">
                        <span>{step.name}</span>
                        <strong>{step.ok ? 'OK' : 'NG'}</strong>
                      </div>
                      {step.message ? <p>{step.message}</p> : null}
                      {step.errorCode ? <p>code: {step.errorCode}</p> : null}
                      {step.errorDetails ? <p>details: {step.errorDetails}</p> : null}
                      {step.errorHint ? <p>hint: {step.errorHint}</p> : null}
                      {step.suggestion ? <p className="sync-diagnostic__suggestion">{step.suggestion}</p> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>


        </> : null}
        {currentPage === 'danger' ? <>
          <div className="sync-alert sync-alert--warning">同期先やクラウドデータを変更する操作です。通常の同期や再試行には使いません。</div>
          <section className="sync-advanced__section"><h2>新しい同期先を作る</h2><p className="sync-help">現在の接続を外し、自動同期をOFFにします。端末のデータは残ります。</p>
            <button type="button" className="sync-button sync-button--danger" onClick={handleGenerate} disabled={busy || !configured || !authenticated}>新しい接続を作る</button>
          </section>
          <section className="sync-advanced__section sync-advanced__section--danger">
            <h2>クラウドデータの削除</h2>
            <p>クラウド上のデータを削除し、この端末の同期接続を解除します。端末内の問題や学習履歴は残ります。</p>
            <button
              type="button"
              className="sync-button sync-button--danger"
              onClick={() => void prepareDeleteCloudData()}
              disabled={!canRun || !configured}
            >
              クラウドデータを削除
            </button>
          </section>

        </> : null}
      </main>
      <ConfirmDialog
        open={Boolean(pendingConnectSyncId)}
        title="同期先を変更しますか？"
        message={'現在の同期先との接続を解除し、確認した接続先へ切り替えます。誤った自動送信を防ぐため、自動同期はOFFになります。'}
        confirmLabel="同期先を変更"
        onCancel={() => setPendingConnectSyncId('')}
        onConfirm={() => applyConnectedSyncId(pendingConnectSyncId)}
      />
      <ConfirmDialog
        open={Boolean(pendingGeneratedSyncId)}
        title="新しい同期接続を作りますか？"
        message={'現在の同期先との接続は解除されます。ほかの端末で現在の同期を使い続ける場合は、先に復旧用の同期IDを控えてください。'}
        confirmLabel="新しく作る"
        onCancel={() => setPendingGeneratedSyncId('')}
        onConfirm={() => applyGeneratedSyncId(pendingGeneratedSyncId)}
      />
      <ConfirmDialog
        open={pendingCloudImport !== null}
        fullPage
        title={'クラウドから読み込みますか？'}
        message={pendingCloudImport ? `残す：クラウド（${formatDateTime(pendingCloudImport.remoteUpdatedAt)}）\n${formatSyncSummary(pendingCloudImport.summary)}\n\n上書き：この端末\n端末の復元用バックアップを作成・読み戻し確認してから実行します。` : ''}
        confirmLabel={busy ? '読み込み中…' : 'バックアップして端末を上書き'}
        busy={busy}
        onCancel={cancelCloudImport}
        onConfirm={() => void confirmCloudImport()}
      />
      <ConfirmDialog
        open={pendingCloudOverwrite !== null}
        fullPage
        title="クラウドに別のデータがあります"
        message={pendingCloudOverwrite ? `この端末が最後に確認した後で、クラウド側が更新されています。\n\nこの端末の内容で強制的に上書きしますか？\n端末内容: ${formatSyncSummary(pendingCloudOverwrite.summary)}\n\n必要な場合は、先に「バックアップと復旧」でファイルを保存してください。` : ''}
        confirmLabel="強制上書き"
        onCancel={cancelCloudOverwrite}
        onConfirm={() => void confirmCloudOverwrite()}
      />
      <ConfirmDialog
        open={pendingCloudDelete !== null}
        title="クラウドデータを削除しますか？"
        message={pendingCloudDelete?.expectedUpdatedAt
          ? '現在の同期先に保存された問題、学習履歴、ノートをクラウドから削除し、この端末の同期接続を解除します。\nこの端末内のデータは削除されません。削除後は元に戻せません。'
          : 'この同期先にはクラウドデータが見つかりません。この端末の同期接続だけを解除します。端末内のデータは残ります。'}
        confirmLabel={busy ? '削除中…' : 'クラウドから削除'}
        busy={busy}
        onCancel={() => setPendingCloudDelete(null)}
        onConfirm={() => void confirmDeleteCloudData()}
      />

    </div>
  );

}

function formatDateTime(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

function formatPairingCode(value: string) {
  const normalized = normalizePairingCode(value);
  return normalized.length === 8 ? `${normalized.slice(0, 4)} ${normalized.slice(4)}` : normalized;
}

function formatSyncSummary(summary: SyncPayloadSummary) {
  return `フォルダ${summary.folderCount} / セット${summary.problemSetCount} / 問題${summary.questionCount} / 進捗${summary.progressCount} / ノート${summary.noteCount} / ${formatBytes(summary.byteSize)}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatBackupFileDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
