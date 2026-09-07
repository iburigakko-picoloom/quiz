import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const appSource = readSource('../src/App.tsx');
const autoSyncSource = readSource('../src/components/AutoSyncController.tsx');
const serviceWorkerRegistrationSource = readSource('../src/registerServiceWorker.ts');
const syncServiceSource = readSource('../src/utils/syncService.ts');
const syncScreenSource = readSource('../src/screens/SyncScreen.tsx');

test('automatic cloud imports wait until local work is no longer protected', () => {
  assert.match(appSource, /<AutoSyncController protectedWorkReason=\{protectedWorkReason\}/);
  assert.match(autoSyncSource, /open=\{pendingRemoteImport !== null && protectedWorkReason === null\}/);
  assert.match(autoSyncSource, /if \(protectedWorkReasonRef\.current\)/);
  assert.match(autoSyncSource, /latestSettings\.syncId !== target\.syncId/);
  assert.match(autoSyncSource, /if \(protectedWorkReasonRef\.current\)[\s\S]*?自動同期: 作業終了後に保存します/);
  assert.match(autoSyncSource, /uploadRunningRef\.current \|\| remoteCheckRunningRef\.current/);
  assert.match(autoSyncSource, /remoteCheckRunningRef\.current \|\| uploadRunningRef\.current/);
  assert.match(autoSyncSource, /shouldCheckRemoteAfterUpload[\s\S]*?uploadRunningRef\.current = false;[\s\S]*?checkRemote\(true\)/);
  assert.match(appSource, /screen\.name === 'noteList' \|\| screen\.name === 'noteDetail'\) return 'notes'/);
  assert.match(appSource, /screen\.name === 'import'\) return 'import'/);
  assert.match(appSource, /screen\.name === 'sync'\) return 'sync'/);
  assert.match(appSource, /backupImportActive\) return 'backup'/);
  assert.match(autoSyncSource, /previousReason && !protectedWorkReason/);
  assert.match(syncServiceSource, /waitForPendingCategoryNoteSaves\(\)[\s\S]*?withCoordinatedDataMutation[\s\S]*?importQuizMakeDataUnlocked\(payload/);
});

test('service worker activation never reloads over protected or failed local saves', () => {
  assert.match(serviceWorkerRegistrationSource, /if \(getActiveProtectedWorkReason\(\)\)/);
  assert.match(serviceWorkerRegistrationSource, /if \(!appDataSaved \|\| getActiveProtectedWorkReason\(\)\)/);
  assert.match(serviceWorkerRegistrationSource, /notifyReloadReady\(controller\)/);
  assert.match(appSource, /waitingWorker\?\.state === 'activated'/);
  assert.match(appSource, /disabled=\{protectedWorkReason !== null\}/);
});

test('auto sync retries revision races shortly after releasing its network lock', () => {
  assert.match(autoSyncSource, /const LOCAL_CHANGE_RETRY_MS = 750/);
  assert.match(autoSyncSource, /result\.code === 'local_changed'[\s\S]*?shouldRetryLocalChanges = true/);
  assert.match(autoSyncSource, /result\.value\.localChangesPending[\s\S]*?shouldRetryLocalChanges = true/);
  assert.match(autoSyncSource, /uploadRunningRef\.current = false;[\s\S]*?scheduleLocalChangeRetry\(\)/);
  assert.match(autoSyncSource, /uploadRunningRef\.current \|\| remoteCheckRunningRef\.current[\s\S]*?scheduleLocalChangeRetry\(\)/);
});

test('finished sync requests cannot revive a connection changed while they were running', () => {
  assert.match(autoSyncSource, /uploadSyncData\(settings\.syncId[\s\S]*?getAutoSyncSettings\(\)[\s\S]*?latestSettings\.syncId !== settings\.syncId/);
  assert.match(autoSyncSource, /getRemoteSyncMeta\(settings\.syncId\)[\s\S]*?getAutoSyncSettings\(\)[\s\S]*?latestSettings\.syncId !== settings\.syncId/);
  assert.match(syncServiceSource, /withCoordinatedDataRead\(\['app', 'notes'\][\s\S]*?uploadSyncDataUnlocked[\s\S]*?const afterUpload[\s\S]*?setLastSyncStateForConnection\(normalizedSyncId/);
  assert.match(syncServiceSource, /downloadSyncData[\s\S]*?if \(!isCurrentSyncConnection\(normalizedSyncId\)\) return syncConnectionChangedResult\(\);[\s\S]*?parseRemoteRecord[\s\S]*?if \(!isCurrentSyncConnection\(normalizedSyncId\)\) return syncConnectionChangedResult\(\);/);
  assert.match(syncScreenSource, /addEventListener\('storage', refreshExternalSyncState\)/);
  assert.match(syncScreenSource, /getStoredSyncId\(\)\.trim\(\) !== target\.syncId[\s\S]*?以前の接続からの読み込みを中止しました/);
  assert.match(syncScreenSource, /const connectionAtStart = getStoredSyncId\(\)\.trim\(\);[\s\S]*?redeemSyncPairingCode[\s\S]*?currentConnection !== connectionAtStart[\s\S]*?setPendingConnectSyncId\(result\.value\)/);
});

test('manual sync never reports an older snapshot as the latest saved state', () => {
  assert.match(syncScreenSource, /result\.value\.localChangesPending/);
  assert.match(syncScreenSource, /最新の内容でもう一度「クラウドへ保存」を押してください/);
  assert.match(syncScreenSource, /result\.value\.localChangesPending[\s\S]*?return;/);
  assert.match(syncScreenSource, /expectedRemoteUpdatedAt: result\.remoteUpdatedAt/);
  assert.match(syncScreenSource, /target\.expectedRemoteUpdatedAt/);
});
