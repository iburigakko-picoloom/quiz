import { getCloudAccessToken } from './cloudService';
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
  getAutoSyncSettings, getLastSyncState, getRemoteSyncConfig, getRemoteSyncMeta,
  isQuizMakeStorageKey, setLastSyncStateForConnection, waitForLocalPersistence,
} from './syncService';

export async function runAppRecordSync(syncId: string, apply: RecordSyncGuards['apply']): Promise<RecordSyncOutcome> {
  const config = getRemoteSyncConfig();
  if (!config) throw new Error('クラウド同期が設定されていません。');
  const started = getAutoSyncSettings();
  if (!started.enabled || started.syncId !== syncId) throw new Error('同期先が変わりました。');
  const initialAccess = await getCloudAccessToken();
  if (!initialAccess.ok) throw new RecordSyncRpcError('authentication_required', initialAccess.message);
  const connection = { project: new URL(config.url).origin, userId: initialAccess.userId, syncId };
  const assertCurrent = async () => {
    const current = getAutoSyncSettings();
    if (!current.enabled || current.syncId !== syncId) throw new Error('同期先が変わりました。');
    if (!isRecordSyncOptedIn(syncId)) throw new Error('高速同期がOFFになりました。');
    const saved = await waitForLocalPersistence();
    if (!saved.ok) throw new Error(saved.error);
  };
  await assertCurrent();
  const remote = await getRemoteSyncMeta(syncId);
  if (!remote.ok || !remote.value) throw new Error(remote.ok ? '同期先のSnapshotが見つかりません。' : remote.error);
  const expected = remote.value.updatedAt;
  const rpc = createRecordSyncRpc({ url: config.url, anonKey: config.anonKey, connection,
    async access() {
      const current = await getCloudAccessToken();
      if (!current.ok) throw new RecordSyncRpcError('authentication_required', current.message);
      return current;
    },
    assertCurrent() {
      const current = getAutoSyncSettings();
      if (!current.enabled || current.syncId !== syncId) throw new Error('同期先が変わりました。');
    },
  });
  await rpc.open(expected);
  const db = await withCoordinatedDataRead(['app','notes'],async()=>{
    await openCoLocatedNoteDb();
    await replayLocalStorageProjections();
    await captureSyncedLocalStorage(isQuizMakeStorageKey);
    return openQuestionImageRecordDb();
  },{requireCrossContext:true});
  const imageTransport = createQuestionImageTransport(config, initialAccess);
  const media = await prepareRecordMaterialOutbox(db,createMaterialTransport(config,initialAccess),assertCurrent);
  if(media.more)return {status:'more',uploaded:0,downloaded:0};
  const images = await prepareQuestionImageOutbox(db,imageTransport,assertCurrent);
  if(images.more)return {status:'more',uploaded:0,downloaded:0};
  await assertCurrent();
  const result = await runRecordSync(db,connection,rpc,{assertCurrent,apply,prepareMedia:()=>prepareStagedQuestionImages(db,imageTransport,assertCurrent)});
  if (result.status === 'done' && result.uploaded) {
    const latest = await getRemoteSyncMeta(syncId);
    if (!latest.ok || !latest.value) throw new Error(latest.ok ? '保存後の同期先を確認できませんでした。' : latest.error);
    if (!setLastSyncStateForConnection(syncId,{lastSyncAt:latest.value.updatedAt,lastRemoteUpdatedAt:latest.value.updatedAt,status:'同期済み',error:''})) throw new Error('保存後に同期先が変わりました。');
  } else if (result.status === 'done') {
    const last = getLastSyncState();
    if (last.lastSyncAt !== expected) setLastSyncStateForConnection(syncId,{lastSyncAt:expected,lastRemoteUpdatedAt:expected,status:'同期済み',error:''});
  }
  return result;
}
