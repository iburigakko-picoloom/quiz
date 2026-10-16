import { getAccountStorageSession } from './accountStorage';
import { deleteSavedBackup, getSavedBackup, listSavedBackups, settleSavedBackupHistory, type SavedBackupSummary } from './backupRepository';
import { deleteWholeRecovery, getWholeRecovery, listWholeRecovery, type WholeRecoverySummary } from './wholeRecovery';
import { withCoordinatedDataRead } from './dataCoordination';
import { openAppDb } from '../storage';

export const BACKUP_HISTORY_LIMIT = 2;
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

async function hasUnsettledWork():Promise<boolean>{
  const db=await openAppDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['appRecordMeta','appOutbox','appRecordConflicts']);
    const pending=tx.objectStore('appOutbox').count(),store=tx.objectStore('appRecordConflicts');
    const conflicts=store.indexNames?.contains('kind')?store.index('kind').count('legacy-recovery-candidate'):store.count();
    // Count keys instead of reading multi-megabyte frozen requests.
    const stages=['wholeFrozen','wholeConflict','wholeIncoming','pushBatch','pullStage','deltaFrozen','deltaPull'].map(key=>tx.objectStore('appRecordMeta').count(key));
    tx.oncomplete=()=>resolve(Boolean(pending.result||conflicts.result||stages.some(r=>r.result)));
    tx.onabort=()=>reject(tx.error);
  });
}

export function automaticHistoryDeletions(history:BackupHistoryRow[]):BackupHistoryRow[]{
  const candidates=history.filter(item=>Number.isFinite(Date.parse(item.createdAt))
    && ('digest' in item ? /^[a-f0-9]{64}$/.test(item.digest) : item.kind!=='manual'&&!item.format&&item.retentionState==='ready'&&/^[a-f0-9]{64}$/.test(item.contentDigest??'')));
  const digests=new Set<string>(),remove:BackupHistoryRow[]=[];
  for(const item of candidates){
    const digest='digest' in item?item.digest:item.contentDigest!;
    if(digests.has(digest)||digests.size>=BACKUP_HISTORY_LIMIT)remove.push(item);
    else digests.add(digest);
  }
  return remove;
}

async function trimHistory(current:()=>void,newId?:string):Promise<void>{
  if(await hasUnsettledWork())return;
  const history=await listBackupHistory();current();
  if(newId&&!history.some(item=>item.id===newId))return;
  for(const item of automaticHistoryDeletions(history)){
    if(item.id===newId)continue;
    current();
    if(isWhole(item.id))await deleteWholeRecovery(item.id,{coordinationLockHeld:true});
    else await deleteSavedBackup(item.id);
    current();
  }
}

/** For a just-validated file whose stored bytes have already been read back. */
export async function pruneVerifiedBackupHistory(id:string,assertOriginalOwner:()=>void):Promise<void>{
  await withCoordinatedDataRead(['app','notes'],()=>trimHistory(assertOriginalOwner,id),{requireCrossContext:true});
}

/** Kept for older callers. Viewing/retrying never grants permission to delete
 * originals: unknown legacy copies and unresolved work remain protected. */
export async function enforceBackupHistoryLimit():Promise<void>{
  // Retention runs only after a verified save or confirmed synchronization.
}

export async function settleAutomaticBackupHistory():Promise<void>{
  const owner=getAccountStorageSession(),native=globalThis.localStorage;
  const current=()=>{if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('バックアップの保存先が変わりました。');owner?.assertCurrent();};
  await withCoordinatedDataRead(['app','notes'],async()=>{
    current();if(await hasUnsettledWork())return;
    const history=await listSavedBackups();current();
    await settleSavedBackupHistory(history.filter(item=>item.kind==='before-sync'&&!item.format&&item.contentDigest&&item.retentionState==='pending').map(item=>item.id));
    current();await trimHistory(current);
  },{requireCrossContext:true});
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
    const checked = await validateFileBackup(JSON.parse(stored),{retainImages:false});
    current();
    if (!checked.ok || checked.value.payload.backupManifest.completeness !== 'complete') throw new Error('完全なバックアップを確認できません。古いコピーは保持します。');
    await trimHistory(current,id);
  }, {requireCrossContext:true});
}
