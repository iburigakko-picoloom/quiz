export type ProtectedWorkReason = 'backup' | 'create' | 'import' | 'quiz' | 'notes' | 'sync' | 'library';

let activeProtectedWorkReason: ProtectedWorkReason | null = null;
let recordApplyCount = 0;

/** The sync worker owns this protection. Release synchronously after its commit
 * so a stale React busy render cannot interrupt that same worker's next guard.
 * Other consumers (including service-worker activation) still see protected work.
 */
export function beginRecordApply(): () => void {
  recordApplyCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    recordApplyCount--;
  };
}

export function setActiveProtectedWorkReason(reason: ProtectedWorkReason | null) {
  activeProtectedWorkReason = reason;
}

export function getActiveProtectedWorkReason() {
  return activeProtectedWorkReason ?? (recordApplyCount ? 'library' : null);
}
