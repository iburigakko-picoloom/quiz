import type { RecordConflict } from './recordSyncPull';
import { recordConflictIdentity } from './recordConflictPresentation';

/** Comparison originals, not a SyncPayload or a restore command. No connection credentials. */
export function exportRecordConflictOriginals(expected: RecordConflict, current: RecordConflict[], now = new Date().toISOString()): string {
  const latest = current.find(item => item.key === expected.key);
  if (!latest || recordConflictIdentity(latest) !== recordConflictIdentity(expected)) throw new Error('確認中に内容が更新されました。もう一度確認してください。');
  return JSON.stringify({ kind: 'quiz-make-conflict-originals', version: 1, exportedAt: now,
    collection: expected.remote.collection, recordId: expected.remote.id,
    local: { raw: expected.local?.logicalRaw ?? expected.local?.raw ?? null, position: expected.local?.position ?? 0,
      ...(expected.local?.logicalRaw !== undefined ? { transportRaw: expected.local.raw } : {}) },
    remote: { raw: expected.remote.logicalRaw ?? expected.remote.raw, position: expected.remote.position, revision: expected.remote.revision,
      ...(expected.remote.logicalRaw !== undefined ? { transportRaw: expected.remote.raw } : {}) },
  }, null, 2);
}
