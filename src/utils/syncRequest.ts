export const SYNC_RETRY_EVENT = 'quiz-make-sync-retry';
let manualConnection = '';
export const isManualSyncRequested = (syncId: string) => Boolean(syncId && manualConnection === syncId);
export function finishManualSync(syncId: string) { if (manualConnection === syncId) manualConnection = ''; }

/** Manual retry and a resolved conflict join the one automatic upload queue. */
export function requestSyncRetry(syncId: string) {
  manualConnection = syncId;
  window.dispatchEvent(new CustomEvent(SYNC_RETRY_EVENT, { detail: { syncId } }));
}

/** An opted-in connection never silently falls back to a full Snapshot. */
export async function runSelectedSync<T>(recordEnabled: boolean, record: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
  return recordEnabled ? record() : legacy();
}

export async function withRecordSyncLease<T>(locks: LockManager | undefined, operation: () => Promise<T>): Promise<T | null> {
  if (!locks) throw new Error('複数タブ間の同期を安全に実行できません。ブラウザを更新してください。');
  return locks.request('quiz-make-record-sync-network-v1', { ifAvailable: true }, lock => lock ? operation() : null);
}
