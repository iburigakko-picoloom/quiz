import { getCachedCloudAccountIdentity, getCloudAccessToken, getCloudSession } from './cloudService';
import { cloudAccessFailureCode } from './cloudAuthAccess';
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
import { prepareRecordChunks } from './recordChunks';
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
import { WHOLE_SYNC_ROLLOUT_ENABLED } from './wholeSyncRollout';
import { runWholeRecordSync } from './wholeSyncEngine';
import { buildWholeIncomingFile } from './wholeSyncIncoming';
import { getSyncDevice } from './syncDevice';
import { publishSyncProgress, publishSyncAttempt, type SyncProgress } from './syncAttemptStatus';
import { archiveSyncOriginals } from './syncOriginalBackup';
import { readAppOutbox } from './appRecordStorage';
import { materialFileEntry } from './materialModel';
import { recoverLegacyImageMetadata } from './legacyImageRecovery';
import { readWholeBaseline } from './wholeSyncStorage';

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
  if (!initialAccess.ok) throw new RecordSyncRpcError(cloudAccessFailureCode(initialAccess.reason), initialAccess.message);
  const connection = { project: new URL(config.url).origin, userId: initialAccess.userId, syncId };
  const assertCurrent = async () => {
    if (isSyncInteractionProtected() || isAutoUploadBlocked(getActiveProtectedWorkReason())) throw new SyncInterruptedError('protected_work', '内容の確認が終わってから同期を再開します。');
    // The RPC adapter verifies the exact JWT before every network request.
    // This local guard detects account changes without extra Auth round trips.
    const session = await getCloudSession();
    if (!session) { if (getCachedCloudAccountIdentity()?.userId === initialAccess.userId) throw new RecordSyncRpcError('network', 'ログイン状態を一時的に確認できません。未送信の変更は保持しています。'); throw new RecordSyncRpcError('authentication_required', 'ログイン状態を確認してください。未送信の変更は保持しています。'); }
    if (session.user.is_anonymous || session.user.id !== initialAccess.userId) throw new SyncInterruptedError('connection_changed', 'アカウントが変わりました。未送信の変更は保持しています。');
    if (getRemoteSyncConfig()?.url !== config.url || getRemoteSyncConfig()?.anonKey !== config.anonKey) throw new SyncInterruptedError('connection_changed', '接続設定が変わりました。');
    const current = getAutoSyncSettings();
    if ((!current.enabled && !manual) || current.syncId !== syncId) throw new SyncInterruptedError('connection_changed', '同期先が変わりました。');
    if (!isRecordSyncOptedIn(syncId)) throw new SyncInterruptedError('mode_changed', '高速同期がOFFになりました。');
    const saved = await waitForLocalPersistence();
    if (!saved.ok) { step('local_persistence'); throw new SyncLocalPersistenceError(saved.error); }
  };
  await assertCurrent();
  const rpc = createRecordSyncRpc({ url: config.url, anonKey: config.anonKey, connection, onRequest: step,
    async access() {
      const current = await getCloudAccessToken();
      if (!current.ok) throw new RecordSyncRpcError(cloudAccessFailureCode(current.reason), current.message);
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
  const db = await withCoordinatedDataRead(['app','notes'],async()=>{
    await openCoLocatedNoteDb();
    await replayLocalStorageProjections();
    await captureSyncedLocalStorage(isQuizMakeStorageKey);
    return openQuestionImageRecordDb();
  },{requireCrossContext:true});
  // A durable whole baseline proves initialization for this exact connection.
  // Its authenticated status RPC still verifies ownership and the current head.
  if(!WHOLE_SYNC_ROLLOUT_ENABLED||!await readWholeBaseline(db,connection)){
    step('remote_metadata');
    const remote=await getRemoteSyncMeta(syncId);
    if(!remote.ok)throw new RecordSyncRpcError(remote.code??'network',remote.error);
    if(!remote.value)throw new Error('同期先のSnapshotが見つかりません。');
    step('open');await rpc.open(remote.value.updatedAt);
  }
  const imageTransport = createQuestionImageTransport(config, initialAccess);
  const materialTransport = createMaterialTransport(config,initialAccess);
  if(WHOLE_SYNC_ROLLOUT_ENABLED){
    const progress=(value:SyncProgress)=>{try{publishSyncProgress(connection,value);}catch{/* Informational only. */}};
    const result=await runWholeRecordSync(db,connection,rpc,{assertCurrent,apply,step,
      device:getSyncDevice(),
      progress,
      notice:notice=>publishSyncAttempt(connection,{notice}),
      archiveOriginals:(side,rows)=>archiveSyncOriginals(db,connection,side,rows,imageTransport,materialTransport,assertCurrent,progress),
      prepareMedia:()=>prepareStagedQuestionImages(db,imageTransport,assertCurrent,progress),
      incoming:(rows,options)=>buildWholeIncomingFile(db,rows,materialTransport,assertCurrent,progress,options?.allowMissingImages),
      prepareOutgoing:async()=>{
        await assertCurrent();
        await recoverLegacyImageMetadata(db,assertCurrent);
        let total:number|null=null;
        try{
          const pending=await readAppOutbox(db);
          total=pending.filter(row=>row.collection==='indexedDbNotes'&&row.raw!==null&&materialFileEntry(row.id,row.raw)?.kind==='quiz-material-file'||row.collection==='questionImages'&&row.raw!==null&&!JSON.parse(row.raw).path).length;
        }catch{/* An informational count cannot stop synchronization. */}
        const preparing=(value:SyncProgress,offset=0)=>progress({...value,stage:'preparing',completed:value.completed+offset,total:total===null?null:Math.max(total,value.completed+offset)});
        step('materials');preparing({label:'資料を送信中',completed:0,total:null});
        const media=await prepareRecordMaterialOutbox(db,materialTransport,assertCurrent,20,value=>preparing(value));
        step('images');
        const images=await prepareQuestionImageOutbox(db,imageTransport,assertCurrent,20,value=>preparing(value,media.prepared));
        if(media.more||images.more)return {more:true};
        await prepareRecordChunks(db,connection);await assertCurrent();
        progress({label:'送信の準備完了',completed:1,total:1,stage:'preparing'});
      },
    });
    await assertCurrent();step('receipt');if(result.status==='done')progress({label:'同期結果を確認中',completed:0,total:1,stage:'finalizing'});await writeRecordSyncReceipt(db,connection,result);return result;
  }
  step('materials'); const media = await prepareRecordMaterialOutbox(db,createMaterialTransport(config,initialAccess),assertCurrent);
  if(media.more)return {status:'more',uploaded:0,downloaded:0};
  step('images'); const images = await prepareQuestionImageOutbox(db,imageTransport,assertCurrent);
  if(images.more)return {status:'more',uploaded:0,downloaded:0};
  await assertCurrent();
  step('records'); const result = await runRecordSync(db,connection,rpc,{assertCurrent,apply,step,prepareMedia:()=>prepareStagedQuestionImages(db,imageTransport,assertCurrent),prepareOutgoing:async()=>{await assertCurrent();await prepareRecordChunks(db,connection);await assertCurrent()}});
  await assertCurrent();
  step('receipt'); await writeRecordSyncReceipt(db, connection, result);
  return result;
}
