import { getCloudAccessToken, getCloudSession } from './cloudService';
import { withCoordinatedDataRead } from './dataCoordination';
import { captureSyncedLocalStorage, replayLocalStorageProjections } from './localStorageRecords';
import { openCoLocatedNoteDb } from './noteRecordMigration';
import { createRecordSyncRpc, RecordSyncRpcError } from './recordSyncNetwork';
import { createMaterialTransport } from './materialCloud';
import { prepareRecordMaterialOutbox } from './recordMaterialSync';
import { createQuestionImageTransport } from './questionImageCloud';
import { openQuestionImageRecordDb } from './questionImageRecords';
import { prepareQuestionImageOutbox, prepareStagedQuestionImages } from './recordQuestionImageSync';
import { runRecordSync, type RecordSyncGuards, type RecordSyncOutcome } from './recordSyncEngine';
import { isRecordSyncOptedIn } from './recordSyncOptIn';
import {
  getAutoSyncSettings, getRemoteSyncConfig, getRemoteSyncMeta,
  isQuizMakeStorageKey, waitForLocalPersistence,
} from './syncService';

import { withRecordSyncLease } from './syncRequest';
import { writeRecordSyncReceipt } from './recordSyncStatus';
import { isAutoUploadBlocked } from './autoSyncScheduler';
import { getActiveProtectedWorkReason } from './protectedWork';
import { isSyncInteractionProtected } from './syncInteraction';
import { SyncInterruptedError, SyncLocalPersistenceError } from './syncInterruption';

export async function runAppRecordSync(syncId: string, apply: RecordSyncGuards['apply'], manual = false, step: (value: string) => void = () => {}): Promise<RecordSyncOutcome> {
  const report = (value: string) => { try { step(value); } catch { /* Status cannot interrupt synchronization. */ } };
  return await withRecordSyncLease(navigator.locks, () => runAppRecordSyncLocked(syncId, apply, manual, report))
    ?? { status: 'more', uploaded: 0, downloaded: 0 };
}

async function runAppRecordSyncLocked(syncId: string, apply: RecordSyncGuards['apply'], manual: boolean, step: (value: string) => void): Promise<RecordSyncOutcome> {
  const config = getRemoteSyncConfig();
  if (!config) throw new Error('クラウド同期が設定されていません。');
  const started = getAutoSyncSettings();
  if ((!started.enabled && !manual) || started.syncId !== syncId) throw new SyncInterruptedError('connection_changed', '同期先が変わりました。');
  step('authentication');
  const initialAccess = await getCloudAccessToken();
  if (!initialAccess.ok) throw new RecordSyncRpcError('authentication_required', initialAccess.message);
  const connection = { project: new URL(config.url).origin, userId: initialAccess.userId, syncId };
  const assertCurrent = async () => {
    if (isSyncInteractionProtected() || isAutoUploadBlocked(getActiveProtectedWorkReason())) throw new SyncInterruptedError('protected_work', '内容の確認が終わってから同期を再開します。');
    // The RPC adapter verifies the exact JWT before every network request.
    // This local guard detects account changes without extra Auth round trips.
    const session = await getCloudSession();
    if (!session || session.user.is_anonymous || session.user.id !== initialAccess.userId) throw new RecordSyncRpcError('authentication_required', 'ログイン状態が変わりました。未送信の変更は保持しています。');
    if (getRemoteSyncConfig()?.url !== config.url || getRemoteSyncConfig()?.anonKey !== config.anonKey) throw new SyncInterruptedError('connection_changed', '接続設定が変わりました。');
    const current = getAutoSyncSettings();
    if ((!current.enabled && !manual) || current.syncId !== syncId) throw new SyncInterruptedError('connection_changed', '同期先が変わりました。');
    if (!isRecordSyncOptedIn(syncId)) throw new SyncInterruptedError('mode_changed', '高速同期がOFFになりました。');
    const saved = await waitForLocalPersistence();
    if (!saved.ok) { step('local_persistence'); throw new SyncLocalPersistenceError(saved.error); }
  };
  await assertCurrent();
  step('remote_metadata');
  const remote = await getRemoteSyncMeta(syncId);
  if (!remote.ok) throw new RecordSyncRpcError(remote.code ?? 'network', remote.error);
  if (!remote.value) throw new Error('同期先のSnapshotが見つかりません。');
  const expected = remote.value.updatedAt;
  const rpc = createRecordSyncRpc({ url: config.url, anonKey: config.anonKey, connection, onRequest: step,
    async access() {
      const current = await getCloudAccessToken();
      if (!current.ok) throw new RecordSyncRpcError('authentication_required', current.message);
      return current;
    },
    assertCurrent() {
      if (isSyncInteractionProtected() || isAutoUploadBlocked(getActiveProtectedWorkReason())) throw new SyncInterruptedError('protected_work', '内容の確認が終わってから同期を再開します。');
      if (!isRecordSyncOptedIn(syncId)) throw new SyncInterruptedError('mode_changed', '高速同期がOFFになりました。');
      if (getRemoteSyncConfig()?.url !== config.url || getRemoteSyncConfig()?.anonKey !== config.anonKey) throw new SyncInterruptedError('connection_changed', '接続設定が変わりました。');
      const current = getAutoSyncSettings();
      if ((!current.enabled && !manual) || current.syncId !== syncId) throw new SyncInterruptedError('connection_changed', '同期先が変わりました。');
    },
  });
  step('open'); await rpc.open(expected);
  const db = await withCoordinatedDataRead(['app','notes'],async()=>{
    await openCoLocatedNoteDb();
    await replayLocalStorageProjections();
    await captureSyncedLocalStorage(isQuizMakeStorageKey);
    return openQuestionImageRecordDb();
  },{requireCrossContext:true});
  const imageTransport = createQuestionImageTransport(config, initialAccess);
  step('materials'); const media = await prepareRecordMaterialOutbox(db,createMaterialTransport(config,initialAccess),assertCurrent);
  if(media.more)return {status:'more',uploaded:0,downloaded:0};
  step('images'); const images = await prepareQuestionImageOutbox(db,imageTransport,assertCurrent);
  if(images.more)return {status:'more',uploaded:0,downloaded:0};
  await assertCurrent();
  step('records'); const result = await runRecordSync(db,connection,rpc,{assertCurrent,apply,step,prepareMedia:()=>prepareStagedQuestionImages(db,imageTransport,assertCurrent)});
  await assertCurrent();
  step('receipt'); await writeRecordSyncReceipt(db, connection, result);
  return result;
}
