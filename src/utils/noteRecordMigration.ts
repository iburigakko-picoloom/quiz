import { exportAppDataRaw, openAppDb } from '../storage';
import { saveAppRecords } from './appRecordStorage';
import { NOTE_CURRENT_STORE, NOTE_BACKUP_STORE, NOTE_RECORD_TRANSACTION_STORES, queueNoteRecordWrite, trackNoteTransaction, noteOperationEpoch, assertNoteOperationEpoch } from './auxiliaryRecordStorage';
import type { AppData } from '../types';

const MIGRATION = 'notesMigrationV1';
let legacyPromise: Promise<IDBDatabase> | null = null;
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('ノートの移行を完了できませんでした。')); });
}
async function isMigrated(db: IDBDatabase): Promise<boolean> {
  const tx = db.transaction('appRecordMeta', 'readonly'); const completion = done(tx);
  const marker = tx.objectStore('appRecordMeta').get(MIGRATION);
  await completion; return marker.result === 1;
}

/** Called under the existing origin coordination lock. The original DB remains
 * untouched; source, backup, record and Outbox become authoritative together.
 */
export async function openCoLocatedNoteDb(migrate = true): Promise<IDBDatabase> {
  const epoch = noteOperationEpoch();
  const db = await openAppDb();
  if (await isMigrated(db)) { assertNoteOperationEpoch(epoch); return db; }
  const legacy = await openLegacyNoteDb();
  // Read/recovery must remain possible even when AppData itself needs repair.
  if (!migrate) return legacy;
  const raw = await exportAppDataRaw({ coordinationLockHeld: true });
  assertNoteOperationEpoch(epoch);
  await saveAppRecords(db, JSON.parse(raw) as AppData, new Date().toISOString(), () => ({ raw, savedAt: new Date().toISOString() }));
  assertNoteOperationEpoch(epoch);
  // Include durable localStorage fallbacks, which can be newer than the old
  // note DB after a quota error. Recovery mode preserves available values and
  // keeps any provenance taint until an explicit import establishes authority.
  const { exportCategoryNotesRaw } = await import('./noteStorage');
  const authoritativeNotes = await exportCategoryNotesRaw({ coordinationLockHeld: true, mode: 'recovery' });
  assertNoteOperationEpoch(epoch);
  {
    const source = legacy.transaction([NOTE_CURRENT_STORE, NOTE_BACKUP_STORE], 'readonly');
    const read = done(source);
    const stores = [NOTE_CURRENT_STORE, NOTE_BACKUP_STORE].map(name => ({ name, keys: source.objectStore(name).getAllKeys(), values: source.objectStore(name).getAll() }));
    await read;
    assertNoteOperationEpoch(epoch);
    const tx = db.transaction(NOTE_RECORD_TRANSACTION_STORES, 'readwrite'); const completion = done(tx);
    trackNoteTransaction(tx);
    const marker = tx.objectStore('appRecordMeta').get(MIGRATION);
    marker.onsuccess = () => {
      if (marker.result === 1) return;
      try {
        for (const store of stores) store.keys.result.forEach((key, index) => {
          const value = store.values.result[index];
          if (typeof key !== 'string' || typeof value !== 'string') throw new Error('ノート移行元の形式が不正です。');
          tx.objectStore(store.name).put(value, key);
        });
        Object.entries(authoritativeNotes).forEach(([key,value]) => {
          tx.objectStore(NOTE_CURRENT_STORE).put(value,key);
          queueNoteRecordWrite(tx,key,value);
        });
        tx.objectStore('appRecordMeta').put(1, MIGRATION);
      } catch { tx.abort(); }
    };
    await completion;
  }
  return db;
}

function openLegacyNoteDb(): Promise<IDBDatabase> {
  if (legacyPromise) return legacyPromise;
  legacyPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(accountDatabaseName('quiz-make-notes-v1'), 2);
    let rejected = false;
    opening.onupgradeneeded = () => {
      for (const name of [NOTE_CURRENT_STORE, NOTE_BACKUP_STORE]) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name);
    };
    opening.onsuccess = () => {
      if (rejected) { opening.result.close(); return; }
      opening.result.onversionchange = () => { opening.result.close(); legacyPromise = null; };
      opening.result.onclose = () => { legacyPromise = null; };
      resolve(opening.result);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { rejected = true; reject(new Error('別のタブがノートの移行を妨げています。')); };
  });
  void legacyPromise.catch(() => { legacyPromise = null; });
  return legacyPromise;
}
import { accountDatabaseName } from './accountStorage';
