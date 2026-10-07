import { getAccountStorageSession } from './accountStorage';
import { deleteSavedBackup, getSavedBackup, listSavedBackups, type SavedBackupSummary } from './backupRepository';
import { deleteWholeRecovery, getWholeRecovery, listWholeRecovery, type WholeRecoverySummary } from './wholeRecovery';
import { withCoordinatedDataRead } from './dataCoordination';

export const BACKUP_HISTORY_LIMIT = 10;
export type BackupHistoryRow = SavedBackupSummary | WholeRecoverySummary;
const isWhole = (id: string) => id.startsWith('quizMake:wholeRecovery:');

export async function listBackupHistory(): Promise<BackupHistoryRow[]> {
  const owner = getAccountStorageSession();
  const [saved, whole] = await Promise.all([listSavedBackups(), listWholeRecovery()]);
  if (owner !== getAccountStorageSession()) throw new Error('バックアップのアカウントが変わりました。');
  owner?.assertCurrent();
  return [...saved, ...whole].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function readBackupHistoryFile(id: string): Promise<string | undefined> {
  return isWhole(id) ? getWholeRecovery(id) : (await getSavedBackup(id))?.raw;
}

/** Only a durable, reread and media-verified new copy can authorize retention.
 * Opening the list, failed saves and partial rescue files never delete originals. */
export async function pruneBackupHistoryAfterSave(id: string, expectedRaw: string, assertOriginalOwner: () => void): Promise<void> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const current = () => {
    assertOriginalOwner();
    if (owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('バックアップの保存先が変わりました。古いコピーは保持します。');
    owner?.assertCurrent();
  };
  await withCoordinatedDataRead(['app','notes'], async () => {
    current();
    const stored = await readBackupHistoryFile(id);
    current();
    if (stored !== expectedRaw) throw new Error('新しいバックアップの保存を確認できません。古いコピーは保持します。');
    const { validateFileBackup } = await import('./backupPayload');
    const checked = await validateFileBackup(JSON.parse(stored));
    current();
    if (!checked.ok || checked.value.payload.backupManifest.completeness !== 'complete') throw new Error('完全なバックアップを確認できません。古いコピーは保持します。');
    const history = (await listBackupHistory()).filter(item => Number.isFinite(Date.parse(item.createdAt)));
    current();
    // A backwards device clock must never make the newly saved copy a victim.
    if (!history.slice(0,BACKUP_HISTORY_LIMIT).some(item => item.id === id)) return;
    for (const item of history.slice(BACKUP_HISTORY_LIMIT)) {
      current();
      if (isWhole(item.id)) await deleteWholeRecovery(item.id, {coordinationLockHeld:true});
      else await deleteSavedBackup(item.id);
      current();
    }
  }, {requireCrossContext:true});
}
