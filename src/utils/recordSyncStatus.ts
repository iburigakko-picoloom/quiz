import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import type { RecordSyncOutcome } from './recordSyncEngine';
import type { RecordConflict } from './recordSyncPull';
import { categoryNoteRecoveryKeys, isCategoryNotesRecoveryRequired } from './noteStorage';

export const RECORD_SYNC_STATE_EVENT = 'quiz-make-record-sync-state';
export type RecordSyncStatus = { lastSuccessAt: string; phase: RecordSyncOutcome['status'] | 'idle'; pending: number; conflicts: number; staged: boolean; cursor: number; recoveryNotes?:number; recoveryUnknown?:boolean; mediaPending?:number; deltaEnabled?:boolean; recoveryCandidates?:number; migrationError?:string };
type Receipt = { connection: RecordSyncConnection; lastSuccessAt: string; phase: RecordSyncOutcome['status'] };
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('同期状態を読み取れませんでした。'));
});

export async function readRecordSyncStatus(db: IDBDatabase, connection: RecordSyncConnection): Promise<RecordSyncStatus> {
  const stores = ['appRecordMeta', 'appOutbox', 'appRecordConflicts'];
  if (db.objectStoreNames.contains('contentBlobJobs')) stores.push('contentBlobJobs');
  const tx = db.transaction(stores, 'readonly');
  const completion = done(tx);
  const meta = tx.objectStore('appRecordMeta');
  const binding = meta.get('recordSyncConnection');
  const receipt = meta.get('recordSyncReceipt');
  const cursor = meta.get('pullCursor');
  const stage = meta.get('pullStage');
  const batch = meta.count('pushBatch');
  const wholeConflict = meta.get('wholeConflict');
  const wholeFrozen = meta.count('wholeFrozen');
  const wholeIncoming = meta.count('wholeIncoming');
  const deltaEnabled = meta.get('deltaEnabled');
  const deltaFrozen = meta.count('deltaFrozen');
  const deltaPull = meta.count('deltaPull');
  const deltaCheckpoint = meta.count('deltaCheckpoint');
  const deltaCursor=meta.get('deltaCursor'),migrationError=meta.get('blobMigrationError');
  const conflictStore=tx.objectStore('appRecordConflicts');
  const candidates=conflictStore.indexNames.contains('kind')?conflictStore.index('kind').count('legacy-recovery-candidate'):undefined;
  const blobJobs = stores.includes('contentBlobJobs') ? tx.objectStore('contentBlobJobs').count() : undefined;
  const pending = tx.objectStore('appOutbox').count();
  let conflicts:RecordConflict[]=[];
  stage.onsuccess=()=>{if(stage.result){const request=conflictStore.getAll();request.onsuccess=()=>{conflicts=request.result;};}};
  await completion;
  if (binding.result && !sameRecordSyncConnection(binding.result, connection)) throw new Error('差分履歴は別の接続に属しています。詳細から接続を確認してください。');
  const saved = receipt.result as Receipt | undefined;
  const matches = saved && sameRecordSyncConnection(saved.connection, connection);
  return { lastSuccessAt: matches ? saved.lastSuccessAt : '', phase: matches ? saved.phase : 'idle',
    deltaEnabled: Boolean(deltaEnabled.result), mediaPending: blobJobs?.result ?? 0,
    recoveryCandidates:candidates?.result??0,migrationError:migrationError.result?.message,
    recoveryNotes:categoryNoteRecoveryKeys().length,
    recoveryUnknown:isCategoryNotesRecoveryRequired()&&!categoryNoteRecoveryKeys().length,
    pending: Math.max(pending.result, batch.result, wholeFrozen.result,deltaFrozen.result),
    conflicts: wholeConflict.result && sameRecordSyncConnection(wholeConflict.result.connection,connection)?1:stage.result && sameRecordSyncConnection(stage.result.connection, connection)
      ? conflicts.filter(item => item.operationId && item.remote && item.connection && sameRecordSyncConnection(item.connection, connection)).length : 0,
    staged: Boolean(deltaCheckpoint.result || deltaFrozen.result || deltaPull.result || stage.result && sameRecordSyncConnection(stage.result.connection, connection)||wholeIncoming.result),
    cursor: deltaCursor.result?.revision??(cursor.result && sameRecordSyncConnection(cursor.result.connection, connection) ? cursor.result.cursor : 0) };
}

/** Success belongs to the V2 receipt, never the legacy Snapshot ancestor. */
export async function writeRecordSyncReceipt(db: IDBDatabase, connection: RecordSyncConnection, outcome: RecordSyncOutcome, now = new Date().toISOString()) {
  const tx = db.transaction('appRecordMeta', 'readwrite');
  const completion = done(tx);
  const meta = tx.objectStore('appRecordMeta');
  const binding = meta.get('recordSyncConnection');
  const previous = meta.get('recordSyncReceipt');
  previous.onsuccess = () => {
    if (!binding.result || !sameRecordSyncConnection(binding.result, connection)) { tx.abort(); return; }
    const old = previous.result as Receipt | undefined;
    meta.put({ connection, phase: outcome.status,
      lastSuccessAt: outcome.status === 'done' ? now : old && sameRecordSyncConnection(old.connection, connection) ? old.lastSuccessAt : '' }, 'recordSyncReceipt');
  };
  await completion;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RECORD_SYNC_STATE_EVENT));
}

export function recordSyncSummary(status: RecordSyncStatus): string {
  if(status.recoveryNotes)return `要復旧のノート${status.recoveryNotes}件`;
  if(status.recoveryUnknown)return 'ノートの復旧確認が必要です';
  if(status.migrationError)return '学習データを同期中・本文の移行は再試行待ち';
  if (status.conflicts || status.phase === 'conflict') return '確認が必要です。同期は完了していません';
  if (status.pending) return `未送信の変更があります（${status.pending}件）`;
  if (status.staged || status.phase === 'deferred') return '変更の反映を待っています';
  if (status.phase === 'more') return '同期中…';
  if (status.mediaPending) return '学習データ同期済み・資料転送中';
  if (status.deltaEnabled && status.lastSuccessAt) return '学習データ同期済み';
  return status.lastSuccessAt ? '同期済み' : '同期を確認中…';
}
