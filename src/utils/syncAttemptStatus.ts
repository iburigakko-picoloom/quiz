import type { RecordSyncConnection } from './recordSyncOutbox';
import type { AutoSyncQueueState } from './autoSyncScheduler';
import { SyncInterruptedError } from './syncInterruption';

export const SYNC_ATTEMPT_EVENT = 'quiz-make-sync-attempt';
export type SyncFailure = { code: string; step: string; at: string; message: string };
export const isBlockedSyncFailure = (code: string) => ['local_persistence_failed', 'invalid_response', 'invalid_request',
  'invalid', 'operation_reused', 'quota', 'payload_too_large', 'unavailable', 'media_unsupported', 'legacy_snapshot'].includes(code);
export type SyncAttemptStatus = { phase: 'queued' | 'running' | 'paused' | 'failed' | 'done'; retryAt: number | null;
  pauseReason: string; step: string; lastFailure: SyncFailure | null };
type Entry = { connection: RecordSyncConnection; queue: AutoSyncQueueState; remoteChecking: boolean; result: SyncAttemptStatus };
let entry: Entry | null = null;
const same = (a: RecordSyncConnection, b: RecordSyncConnection) => a.project === b.project && a.userId === b.userId && a.syncId === b.syncId;
const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(SYNC_ATTEMPT_EVENT)); };
function owned(connection: RecordSyncConnection): Entry {
  if (!entry || !same(entry.connection, connection)) entry = { connection: { ...connection }, queue: { phase: 'idle', retryAt: null }, remoteChecking: false,
    result: { phase: 'queued', retryAt: null, pauseReason: '', step: '', lastFailure: null } };
  return entry;
}
export function clearSyncAttemptStatus() { entry = null; changed(); }
export function readSyncAttemptStatus(connection: RecordSyncConnection): SyncAttemptStatus | null {
  if (!entry || !same(entry.connection, connection)) return null;
  const phase = entry.remoteChecking || entry.queue.phase === 'running' ? 'running' : entry.queue.phase === 'queued' ? 'queued' : entry.result.phase;
  return { ...entry.result, phase, retryAt: entry.queue.retryAt };
}
export function publishSyncQueue(connection: RecordSyncConnection, queue: AutoSyncQueueState) { const current = owned(connection); current.queue = { ...queue }; changed(); }
export function publishSyncAttempt(connection: RecordSyncConnection, update: Partial<SyncAttemptStatus>) {
  const current = owned(connection); current.result = { ...current.result, ...update }; changed();
}
export function publishRemoteCheck(connection: RecordSyncConnection, running: boolean) { owned(connection).remoteChecking = running; changed(); }

/** Observes outcomes; it never mutates records, batches, receipts or operations. */
export async function observeRecordSyncAttempt<T extends { status: 'done' | 'more' | 'deferred' | 'conflict' }>(
  run: (step: (value: string) => void) => Promise<T>,
  publish: (update: Partial<SyncAttemptStatus>) => void,
  now = () => new Date().toISOString(),
): Promise<{ outcome: 'done' | 'changed' | 'paused' | 'retry' | 'rate_limited'; result?: T; error?: unknown }> {
  let step = 'prepare';
  const notify = (update: Partial<SyncAttemptStatus>) => { try { publish(update); } catch { /* Informational only. */ } };
  notify({ phase: 'running', pauseReason: '', step });
  try {
    const result = await run(value => { step = value; notify({ step }); });
    if (result.status === 'more') { notify({ phase: 'queued' }); return { outcome: 'changed', result }; }
    if (result.status === 'deferred' || result.status === 'conflict') {
      notify({ phase: 'paused', pauseReason: result.status }); return { outcome: 'paused', result };
    }
    notify({ phase: 'done', pauseReason: '', step: 'done' }); return { outcome: 'done', result };
  } catch (error) {
    if (error instanceof SyncInterruptedError) {
      notify({ phase: 'paused', pauseReason: error.reason }); return { outcome: 'paused', error };
    }
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unexpected';
    const paused = isBlockedSyncFailure(code);
    notify({ phase: paused ? 'paused' : 'failed', pauseReason: paused ? code : '', lastFailure: { code, step, at: now(), message: error instanceof Error ? error.message : '同期を完了できませんでした。' } });
    return { outcome: paused ? 'paused' : code === 'rate_limited' ? 'rate_limited' : 'retry', error };
  }
}
