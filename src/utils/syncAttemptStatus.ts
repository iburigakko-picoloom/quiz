import type { RecordSyncConnection } from './recordSyncOutbox';
import type { AutoSyncQueueState } from './autoSyncScheduler';
import { SyncInterruptedError } from './syncInterruption';
import { integrityCodes, SyncDataError, type SyncFailureDetails } from './syncDataIntegrity';

export const SYNC_ATTEMPT_EVENT = 'quiz-make-sync-attempt';
export type SyncFailure = { code: string; step: string; at: string; message: string; diagnostic?: SyncFailureDetails };
export type SyncProgressStage = 'preparing' | 'comparing' | 'receiving_images' | 'checking_materials' | 'receiving_materials' | 'building_backup' | 'archiving' | 'backup' | 'validating' | 'sending' | 'applying' | 'finalizing';
export type SyncProgress = { label: string; completed: number; total: number | null; stage?: SyncProgressStage };
// Stages have different costs, so this is a work-completion estimate, not an
// elapsed-time forecast. Unknown totals hold at the stage's starting point.
const progressRanges: Record<SyncProgressStage, readonly [number,number]> = {
  preparing:[0,15], comparing:[15,30], receiving_images:[30,50], checking_materials:[50,50],receiving_materials:[50,65],building_backup:[65,68],
  archiving:[68,72], backup:[72,80], validating:[80,85], sending:[85,95], applying:[85,97], finalizing:[97,99],
};
export const isBlockedSyncFailure = (code: string) => ['local_persistence_failed', 'invalid_response', 'invalid_request',
  'invalid', 'operation_reused', 'quota', 'payload_too_large', 'unavailable', 'permission_denied', 'media_unsupported', 'legacy_snapshot','storage_capacity','memory_limit',...integrityCodes].includes(code);
export type SyncAttemptStatus = { phase: 'queued' | 'running' | 'paused' | 'failed' | 'done'; retryAt: number | null;
  pauseReason: string; step: string; lastFailure: SyncFailure | null; progress?: SyncProgress; overallPercent?: number; notice?: string };
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
function resetProgress(current:Entry){delete current.result.progress;current.result.overallPercent=0;}
export function publishSyncQueue(connection: RecordSyncConnection, queue: AutoSyncQueueState) {
  const current = owned(connection);
  if(current.result.phase==='done'&&current.queue.phase==='idle'&&(queue.phase==='queued'||queue.phase==='running'))resetProgress(current);
  current.queue = { ...queue }; changed();
}
export function publishSyncAttempt(connection: RecordSyncConnection, update: Partial<SyncAttemptStatus>) {
  const current = owned(connection);
  if(update.phase==='running'&&update.step==='prepare'&&(current.result.phase==='done'||current.result.overallPercent===undefined))resetProgress(current);
  if (update.step && update.step !== current.result.step || update.phase === 'running' && update.step === 'prepare') delete current.result.progress;
  current.result = { ...current.result, ...update, ...(update.phase==='done'?{overallPercent:100}:{}) }; changed();
}
export function publishSyncProgress(connection: RecordSyncConnection, progress: SyncProgress) {
  if (!Number.isSafeInteger(progress.completed) || progress.completed < 0 || progress.total !== null && (!Number.isSafeInteger(progress.total) || progress.total < 0 || progress.completed > progress.total)) return;
  const current=owned(connection),range=progress.stage?progressRanges[progress.stage]:undefined;
  const fraction=progress.total===null?0:progress.total===0?1:progress.completed/progress.total;
  const percent=range?Math.floor(range[0]+(range[1]-range[0])*fraction):current.result.overallPercent??0;
  publishSyncAttempt(connection, {progress,overallPercent:Math.min(99,Math.max(current.result.overallPercent??0,percent))});
}
export function publishRemoteCheck(connection: RecordSyncConnection, running: boolean) {
  const current=owned(connection);
  if(running&&!current.remoteChecking&&current.result.phase==='done'&&current.queue.phase==='idle')resetProgress(current);
  current.remoteChecking = running; changed();
}

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
    const paused = error instanceof SyncDataError ? !error.retryable : isBlockedSyncFailure(code);
    notify({ phase: paused ? 'paused' : 'failed', pauseReason: paused ? code : '', lastFailure: { code, step, at: now(), message: error instanceof Error ? error.message : '同期を完了できませんでした。',...(error instanceof SyncDataError?{diagnostic:error.diagnostic}:{}) } });
    return { outcome: paused ? 'paused' : code === 'rate_limited' ? 'rate_limited' : 'retry', error };
  }
}
