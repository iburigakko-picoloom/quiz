import { migrateNoteBlobs, migrateImageBlobs } from './blobMigration';
import { startBlobTransfers } from './blobCloud';
import { migrateBackupBlobs } from './backupRepository';
import { writeMeta, trimBlobCache } from './blobVault';
import { migrateArchiveBlobs, migrateLegacyBlobSources } from './blobArchiveMigration';
import { initializeStorageLedger } from './storageLedger';
const active = new WeakMap<IDBDatabase, Promise<void>>();
/** Hash/read-back outside the app's save lock. Each source switch has its own
 * transactional compare-and-set, so answers remain saveable during conversion. */
export function startDeltaBackground(db: IDBDatabase, assertCurrent: () => Promise<void>, assertNetwork: () => Promise<void>): void {
  startBlobTransfers(db, assertNetwork);
  if (active.has(db)) return;
  const task = (async () => {
    await assertCurrent(); await initializeStorageLedger(db);
    const notes = await migrateNoteBlobs(db, assertCurrent), images = await migrateImageBlobs(db, assertCurrent);
    if (notes && images) {
      await migrateBackupBlobs(db, assertCurrent);
      if (await migrateArchiveBlobs(db,assertCurrent)) await migrateLegacyBlobSources(db,assertCurrent);
    }
    await assertCurrent(); await writeMeta(db, 'blobMigrationError', undefined);
    await trimBlobCache(db);
    startBlobTransfers(db, assertNetwork);
  })().catch(async error => {
    try { await assertCurrent(); await writeMeta(db, 'blobMigrationError', { message: error instanceof Error ? error.message : '本文の移行を再試行します。', at: new Date().toISOString() }); } catch { /* Owner changed; never write to the new account. */ }
  }).finally(() => active.delete(db));
  active.set(db, task);
}
