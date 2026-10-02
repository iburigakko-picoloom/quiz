import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import type { RecordSyncOutcome } from './recordSyncEngine';
import type { RecordConflict } from './recordSyncPull';

export const RECORD_SYNC_STATE_EVENT = 'quiz-make-record-sync-state';
export type RecordSyncStatus = { lastSuccessAt: string; phase: RecordSyncOutcome['status'] | 'idle'; pending: number; conflicts: number; staged: boolean; cursor: number };
type Receipt = { connection: RecordSyncConnection; lastSuccessAt: string; phase: RecordSyncOutcome['status'] };
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('同期状態を読み取れませんでした。'));
});

export async function readRecordSyncStatus(db: IDBDatabase, connection: RecordSyncConnection): Promise<RecordSyncStatus> {
  const tx = db.transaction(['appRecordMeta', 'appOutbox', 'appRecordConflicts'], 'readonly');
  const completion = done(tx);
  const meta = tx.objectStore('appRecordMeta');
  const binding = meta.get('recordSyncConnection');
  const receipt = meta.get('recordSyncReceipt');
  const cursor = meta.get('pullCursor');
  const stage = meta.get('pullStage');
  const batch = meta.get('pushBatch');
  const pending = tx.objectStore('appOutbox').count();
  const conflicts = tx.objectStore('appRecordConflicts').getAll();
  await completion;
  if (binding.result && !sameRecordSyncConnection(binding.result, connection)) throw new Error('差分履歴は別の接続に属しています。詳細から接続を確認してください。');
  const saved = receipt.result as Receipt | undefined;
  const matches = saved && sameRecordSyncConnection(saved.connection, connection);
  return { lastSuccessAt: matches ? saved.lastSuccessAt : '', phase: matches ? saved.phase : 'idle',
    pending: Math.max(pending.result, batch.result && sameRecordSyncConnection(batch.result.connection, connection) ? batch.result.operations.length : 0),
    conflicts: stage.result && sameRecordSyncConnection(stage.result.connection, connection)
      ? (conflicts.result as RecordConflict[]).filter(item => item.operationId && item.remote && item.connection && sameRecordSyncConnection(item.connection, connection)).length : 0,
    staged: Boolean(stage.result && sameRecordSyncConnection(stage.result.connection, connection)),
    cursor: cursor.result && sameRecordSyncConnection(cursor.result.connection, connection) ? cursor.result.cursor : 0 };
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
  if (status.conflicts || status.phase === 'conflict') return '確認が必要です。同期は完了していません';
  if (status.pending) return `未送信の変更があります（${status.pending}件）`;
  if (status.staged || status.phase === 'deferred') return '変更の反映を待っています';
  if (status.phase === 'more') return '同期中…';
  return status.lastSuccessAt ? '同期済み' : '同期を確認中…';
}
