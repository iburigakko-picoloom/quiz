import type { ProtectedWorkReason } from './protectedWork';

export type AutoSyncOutcome = 'done' | 'paused' | 'busy' | 'changed' | 'retry' | 'rate_limited';

// Upload only persisted content while studying/editing. Destructive/importing
// workflows still need an exclusive, stable snapshot before anything is sent.
export function isAutoUploadBlocked(reason: ProtectedWorkReason | null): boolean {
  return reason === 'backup' || reason === 'import' || reason === 'sync' || reason === 'library';
}

const SAVE_DELAY_MS = 1500;
const MAX_SAVE_WAIT_MS = 8000;
const LOCAL_CHANGE_RETRY_MS = 750;
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

interface Clock {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
}

/** One trailing upload queue. Requests made during I/O are never dropped. */
export function createAutoSyncScheduler(upload: () => Promise<AutoSyncOutcome>, clock: Clock) {
  let timer: number | null = null;
  let running = false;
  let pending = false;
  let urgent = false;
  let disposed = false;
  let firstChangeAt: number | null = null;
  let retryCount = 0;
  let retryNotBefore = 0;

  function schedule(delay: number) {
    if (disposed || running) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => { timer = null; void run(); }, Math.max(delay, retryNotBefore - clock.now(), 0));
  }

  async function run() {
    if (disposed || running || !pending) return;
    pending = false;
    urgent = false;
    firstChangeAt = null;
    running = true;
    let outcome: AutoSyncOutcome;
    try { outcome = await upload(); }
    catch { outcome = 'retry'; }
    running = false;
    if (disposed) return;
    if (outcome === 'paused') {
      // Keep the request until a new save/resume/reconnect/periodic check.
      const requestedDuringUpload = pending;
      pending = true;
      if (requestedDuringUpload) schedule(urgent ? 0 : SAVE_DELAY_MS);
      return;
    }
    if (outcome === 'retry' || outcome === 'rate_limited') {
      pending = true;
      const delay = outcome === 'rate_limited' ? 60000 : RETRY_DELAYS_MS[Math.min(retryCount++, RETRY_DELAYS_MS.length - 1)];
      retryNotBefore = clock.now() + delay;
      schedule(delay);
      return;
    }
    retryCount = 0;
    retryNotBefore = 0;
    if (outcome === 'busy' || outcome === 'changed') {
      pending = true;
      schedule(LOCAL_CHANGE_RETRY_MS);
    } else if (pending) schedule(urgent ? 0 : SAVE_DELAY_MS);
  }

  return {
    request(immediate = false) {
      if (disposed) return;
      pending = true;
      urgent ||= immediate;
      firstChangeAt ??= clock.now();
      schedule(urgent ? 0 : Math.min(SAVE_DELAY_MS, Math.max(0, MAX_SAVE_WAIT_MS - (clock.now() - firstChangeAt))));
    },
    dispose() {
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
    },
  };
}
