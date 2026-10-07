import { getCloudSession } from './cloudService';
import { saveBackupPayload } from './backupRepository';
import { isRecordSyncOptedIn, setRecordSyncOptIn } from './recordSyncOptIn';
import { computePayloadDigest, downloadSyncData, exportQuizMakeRecoveryData, getRemoteSyncMeta, getStoredSyncId, setAutoSyncEnabled, setLastSyncStateForConnection } from './syncService';
import { verifySnapshotQuestionImages } from './snapshotQuestionImages';
import { assertDataEpochSnapshotCurrent } from './dataCoordination';
import { getAssociatedLocalDataRevision, getLocalDataRevision } from './localDataRevision';

export const needsWholeSyncMigration = isRecordSyncOptedIn;

/** Keep old records, staged conflicts and Blobs intact. Only retire the old sender after verified portable backups. */
export async function migrateToWholeSync(syncId: string, accountId: string): Promise<void> {
  const assertCurrent = async () => {
    const session = await getCloudSession();
    if (getStoredSyncId().trim() !== syncId || !needsWholeSyncMigration(syncId) || session?.user.id !== accountId || session.user.is_anonymous) throw new Error('同期先またはログイン状態が変わりました。移行を中止しました。');
  };
  await assertCurrent();
  const local = await exportQuizMakeRecoveryData();
  const remote = await downloadSyncData(syncId);
  if (!remote.ok) throw new Error(remote.error);
  await verifySnapshotQuestionImages(local);
  if (remote.value) await verifySnapshotQuestionImages(remote.value.payload);
  await saveBackupPayload(local, 'before-sync');
  if (remote.value) await saveBackupPayload(remote.value.payload, 'before-sync', 'クラウド');
  const latestLocal = await exportQuizMakeRecoveryData();
  const latestRemote = await getRemoteSyncMeta(syncId);
  if (!latestRemote.ok) throw new Error(latestRemote.error);
  if (await computePayloadDigest(local) !== await computePayloadDigest(latestLocal) || latestRemote.value?.updatedAt !== remote.value?.updatedAt) throw new Error('バックアップ作成中にデータが更新されました。元データを残して移行を中止しました。');
  await assertCurrent();
  assertDataEpochSnapshotCurrent(latestLocal, ['app', 'notes']);
  if (getAssociatedLocalDataRevision(latestLocal) !== getLocalDataRevision()) throw new Error('バックアップ確認後に端末データが更新されました。移行をやり直してください。');
  const auto = setAutoSyncEnabled(false);
  if (!auto.ok) throw new Error(auto.error);
  if (!setLastSyncStateForConnection(syncId, { lastSyncAt: '', lastUploadHash: '', lastSyncDigest: undefined, lastRemoteUpdatedAt: remote.value?.updatedAt ?? '', status: 'バックアップ済み・使うデータを全体から選んでください', error: '' })) throw new Error('移行の確認状態を保存できませんでした。');
  const migrated = setRecordSyncOptIn(syncId, false);
  if (!migrated.ok) throw new Error(migrated.error);
}
