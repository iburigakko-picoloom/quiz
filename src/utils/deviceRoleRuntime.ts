import { openAppDb } from '../storage';
import { getAccountSyncState } from './accountSync';
import { withCoordinatedDataRead } from './dataCoordination';
import { getActiveProtectedWorkReason } from './protectedWork';
import { readRecordSyncStatus } from './recordSyncStatus';
import type { RecordSyncConnection } from './recordSyncOutbox';
import { waitForLocalPersistence } from './syncService';
import { waitForRecordSyncLease } from './syncRequest';
import { changeDeviceRole, DEVICE_ROLE_EVENT, DEVICE_ROLE_WORK_LOCK, type DeviceRole } from './deviceRole';

export async function setDeviceRole(role: DeviceRole) {
  await changeDeviceRole(role, {
    storage: globalThis.localStorage,
    exclusive: async operation => {
      if (!navigator.locks) throw new Error('端末を安全に切り替えられません。ブラウザを更新してください。');
      return navigator.locks.request(DEVICE_ROLE_WORK_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) return false;
        return waitForRecordSyncLease(navigator.locks, async () => { await operation(); return true; });
      });
    },
    flush: async () => (await waitForLocalPersistence()).ok,
    coordinate: operation => withCoordinatedDataRead(['app', 'notes'], operation, { requireCrossContext: true }),
    assertSafe: async () => {
      if (getActiveProtectedWorkReason()) throw new Error('保存・学習を完了してから切り替えてください。');
      if (!['signed_out', 'ready', 'offline', 'paused', 'failed', 'unavailable'].includes(getAccountSyncState().phase)) throw new Error('同期・復旧を完了してから切り替えてください。');
      const db = await openAppDb();
      const connection = await new Promise<RecordSyncConnection | undefined>((resolve, reject) => {
        const request = db.transaction('appRecordMeta').objectStore('appRecordMeta').get('recordSyncConnection');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (!connection) return;
      const status = await readRecordSyncStatus(db, connection);
      // Ordinary queued edits and media remain in the durable outbox and do not
      // depend on device role. Frozen transfers and recovery state still block.
      if (status.roleTransitionBlocked || status.conflicts || status.staged || status.recoveryNotes || status.recoveryUnknown || status.recoveryCandidates || status.migrationError) {
        throw new Error('同期中の処理・競合の復旧を完了してから切り替えてください。');
      }
      if (getActiveProtectedWorkReason()) throw new Error('保存・学習を完了してから切り替えてください。');
    },
    changed: () => window.dispatchEvent(new Event(DEVICE_ROLE_EVENT)),
  });
}
