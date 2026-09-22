import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAutoSyncScheduler, isAutoUploadBlocked } from '../src/utils/autoSyncScheduler.ts';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const appSource = readSource('../src/App.tsx');
const autoSyncSource = readSource('../src/components/AutoSyncController.tsx');
const serviceWorkerRegistrationSource = readSource('../src/registerServiceWorker.ts');
const syncServiceSource = readSource('../src/utils/syncService.ts');
const syncScreenSource = readSource('../src/screens/SyncScreen.tsx');

test('automatic cloud imports wait until local work is no longer protected', () => {
  assert.match(appSource, /<AutoSyncController protectedWorkReason=\{protectedWorkReason\}/);
  assert.doesNotMatch(autoSyncSource, /ConfirmDialog|importQuizMakeData/);
  assert.match(autoSyncSource, /getRemoteSyncMeta\(settings.syncId\)/);
  assert.doesNotMatch(autoSyncSource, /downloadSyncData|lastSyncAt:\s*meta/);
  assert.match(autoSyncSource, /if \(isAutoUploadBlocked\(protectedWorkReasonRef\.current\)\)[\s\S]*?自動同期: 作業終了後に保存します/);
  assert.match(autoSyncSource, /uploadRunningRef\.current \|\| remoteCheckRunningRef\.current/);
  assert.match(autoSyncSource, /remoteCheckRunningRef\.current \|\| uploadRunningRef\.current/);
  assert.match(autoSyncSource, /shouldCheckRemoteAfterUpload[\s\S]*?uploadRunningRef\.current = false;[\s\S]*?checkRemote\(true\)/);
  assert.match(appSource, /screen\.name === 'noteList' \|\| screen\.name === 'noteDetail'\) return 'notes'/);
  assert.match(appSource, /screen\.name === 'import'\) return 'import'/);
  assert.match(appSource, /screen\.name === 'sync'\) return 'sync'/);
  assert.match(appSource, /backupImportActive\) return 'backup'/);
  assert.match(autoSyncSource, /previousReason !== protectedWorkReason && !isAutoUploadBlocked\(protectedWorkReason\)/);
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
  assert.match(autoSyncSource, /result\.code === 'local_changed'[\s\S]*?return 'changed'/);
  assert.match(autoSyncSource, /result\.value\.localChangesPending[\s\S]*?return 'changed'/);
  assert.match(autoSyncSource, /uploadRunningRef\.current \|\| remoteCheckRunningRef\.current\) return 'busy'/);
  assert.match(autoSyncSource, /finally \{\s*uploadRunningRef\.current = false/);
});

function queueHarness(upload) {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout: (timer) => timers.delete(timer),
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    queue: createAutoSyncScheduler(upload, clock),
    settle,
    async advance(ms) {
      const target = now + ms;
      for (let safety = 0; safety < 100; safety++) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) { now = target; return; }
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      throw new Error('runaway auto sync timer');
    },
  };
}

test('durable saves debounce promptly, but continuous edits cannot postpone uploads indefinitely', async () => {
  let calls = 0;
  const h = queueHarness(async () => { calls++; return 'done'; });
  h.queue.request();
  await h.advance(1000); h.queue.request();
  await h.advance(1499); assert.equal(calls, 0);
  await h.advance(1); assert.equal(calls, 1);
  h.queue.request();
  for (let i = 0; i < 7; i++) { await h.advance(1000); h.queue.request(); }
  await h.advance(1000); assert.equal(calls, 2);
  h.queue.dispose();
});

test('a save during upload is sent afterward, and busy/local revision races retry without overlap', async () => {
  let finish;
  let calls = 0;
  const h = queueHarness(() => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve(calls === 2 ? 'busy' : calls === 3 ? 'changed' : 'done');
  });
  h.queue.request(true); await h.advance(0);
  h.queue.request(); h.queue.request(); await h.advance(5000);
  assert.equal(calls, 1);
  finish('done'); await h.settle();
  await h.advance(1500); assert.equal(calls, 2);
  await h.advance(750); assert.equal(calls, 3);
  await h.advance(750); assert.equal(calls, 4);
  await h.advance(60000); assert.equal(calls, 4);
  h.queue.dispose();
});

test('network retries back off, rate limits are respected, and cleanup cancels queued work', async () => {
  let calls = 0;
  const h = queueHarness(async () => { calls++; if (calls === 1) throw new Error('offline'); return calls === 2 ? 'retry' : calls === 3 ? 'rate_limited' : 'done'; });
  h.queue.request(true); await h.advance(0);
  await h.advance(4999); assert.equal(calls, 1);
  await h.advance(1); assert.equal(calls, 2);
  await h.advance(15000); assert.equal(calls, 3);
  h.queue.request(true); await h.advance(59999); assert.equal(calls, 3);
  await h.advance(1); assert.equal(calls, 4);
  h.queue.request(); h.queue.dispose(); await h.advance(60000);
  assert.equal(calls, 4);
});

test('offline/protected work resumes on a new request; startup rechecks persisted data and stale runs cannot swallow reconnects', async () => {
  let calls = 0;
  let finish;
  const h = queueHarness(() => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve(calls === 2 ? 'paused' : 'done');
  });
  h.queue.request(true); await h.advance(0);
  h.queue.request(true); finish('paused'); await h.settle(); await h.advance(0);
  assert.equal(calls, 2);
  await h.advance(60000); assert.equal(calls, 2);
  h.queue.request(true); await h.advance(0); assert.equal(calls, 3);
  h.queue.dispose();
  const restarted = queueHarness(async () => { calls++; return 'done'; });
  restarted.queue.request(true); await restarted.advance(0); assert.equal(calls, 4);
  restarted.queue.dispose();
});

test('saved answers and memos may upload during study; imports and destructive workflows stay protected', () => {
  for (const reason of [null, 'quiz', 'notes', 'create']) assert.equal(isAutoUploadBlocked(reason), false);
  for (const reason of ['sync', 'backup', 'library', 'import']) assert.equal(isAutoUploadBlocked(reason), true);
  for (const event of ["'online'", "'pageshow'", "'pagehide'", 'LOCAL_DATA_SAVED_EVENT']) {
    assert.ok(autoSyncSource.includes(`addEventListener(${event}`));
    assert.ok(autoSyncSource.includes(`removeEventListener(${event}`));
  }
  assert.match(autoSyncSource, /onCloudAuthStateChange\(\(\) => uploadQueue.request\(true\)\)/);
  assert.match(autoSyncSource, /expectedRemoteUpdatedAt: lastState.lastSyncAt \|\| null,\s*force: false/);
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
