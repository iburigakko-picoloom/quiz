import { accountLocalStorage as localStorage, accountDatabaseName, getAccountStorageSession } from './accountStorage';
import type { SyncPayload } from './syncService';

export interface SavedBackup { id: string; createdAt: string; kind: 'manual' | 'before-import' | 'before-sync' | 'before-logout'; raw: string; byteSize?: number; legacyOriginalRaw?: string; }
export type SavedBackupSummary = Omit<SavedBackup, 'raw' | 'byteSize' | 'legacyOriginalRaw'> & { byteSize: number };
export function summarizeSavedBackup(record: SavedBackup): SavedBackupSummary {
  return { id: record.id, createdAt: record.createdAt, kind: record.kind,
    byteSize: typeof record.byteSize === 'number' && Number.isFinite(record.byteSize) && record.byteSize >= 0 ? record.byteSize : new Blob([record.raw]).size };
}
const DB = 'quiz-make-backups';
// Durable backups must not be matched by legacy temporary-backup cleanup.
const PREFIX = 'quizMake:sync:saved-backup:';
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const owner = getAccountStorageSession(); let blocked = false;
    const request = indexedDB.open(accountDatabaseName(DB), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('backups', { keyPath: 'id' });
    request.onsuccess = () => { try { if (blocked) { request.result.close(); return; } if (owner !== getAccountStorageSession()) throw new Error('バックアップの保存先が変わりました。'); owner?.assertCurrent(); request.result.onversionchange = () => request.result.close(); resolve(request.result); } catch (error) { request.result.close(); reject(error); } };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('バックアップ保存領域を開けません。別のタブを閉じて再試行してください。')); };
  });
}
/** Move one old backup at a time, retaining its exact serialized original. */
export async function migrateSavedBackups(): Promise<{ moved: number; retained: number }> {
  const result = { moved: 0, retained: 0 }; if (typeof indexedDB === 'undefined') return result;
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const current = () => { if (owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('バックアップ移行中にアカウントが変わりました。原本は保持しています。'); owner?.assertCurrent(); };
  const keys: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(PREFIX)) keys.push(key); }
  for (const key of keys) {
    current(); const original = localStorage.getItem(key); if (original === null) continue;
    let record: SavedBackup;
    try {
      record = JSON.parse(original);
      if (!record || key !== PREFIX + record.id || typeof record.raw !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || !['manual', 'before-import', 'before-sync', 'before-logout'].includes(record.kind)) throw new Error('Invalid backup');
    } catch { result.retained++; continue; }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(original)))].map(n => n.toString(16).padStart(2, '0')).join('');
    const db = await database();
    try {
      current();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite'), store = tx.objectStore('backups'), old = store.get(record.id); let failure: unknown;
        old.onsuccess = () => { try {
          current(); const id = old.result && (old.result.raw !== record.raw || old.result.createdAt !== record.createdAt || old.result.kind !== record.kind || old.result.legacyOriginalRaw && old.result.legacyOriginalRaw !== original) ? record.id + '-legacy-' + digest : record.id;
          record = { ...record, id, byteSize: new Blob([record.raw]).size, legacyOriginalRaw: original };
          const existing = store.get(id); existing.onsuccess = () => { try { current(); if (existing.result && existing.result.raw !== record.raw) throw new Error('保管済みバックアップが異なります。'); store.put(record); } catch (error) { failure = error; tx.abort(); } };
        } catch (error) { failure = error; tx.abort(); } };
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('旧バックアップを保存できません。'));
      });
      const stored = await new Promise<SavedBackup>((resolve, reject) => { const tx = db.transaction('backups'), request = tx.objectStore('backups').get(record.id); tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); });
      current(); if (stored?.raw !== record.raw || stored.legacyOriginalRaw !== original) throw new Error('旧バックアップの読み戻しを確認できません。原本は保持しています。');
      if (localStorage.getItem(key) === original) { try { localStorage.removeItem(key); } catch { /* Retry verified cleanup on the next call. */ } }
      if (localStorage.getItem(key) === null) result.moved++; else result.retained++;
    } finally { db.close(); }
  }
  return result;
}
async function operation<T>(mode: IDBTransactionMode, execute: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('backups', mode);
    const request = execute(transaction.objectStore('backups'));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('バックアップを保存できませんでした。')); };
  });
}
export async function saveBackupPayload(payload: SyncPayload, kind: SavedBackup['kind']): Promise<SavedBackup & {cleanupWarning?: string}> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const current = () => { if(owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('バックアップの保存先が変わりました。原本は保持しています。'); owner?.assertCurrent(); };
  current();
  const record: SavedBackup = { id: `backup-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), kind, raw: JSON.stringify(payload) };
  record.byteSize = new Blob([record.raw]).size;
  if (typeof indexedDB === 'undefined') localStorage.setItem(PREFIX + record.id, JSON.stringify(record));
  else await operation('readwrite', (store) => store.add(record));
  const checked = await getSavedBackup(record.id);
  current();
  if (!checked || checked.raw !== record.raw) throw new Error('バックアップの読み戻しを確認できませんでした。');
  if ('backupManifest' in payload && (payload.backupManifest as {completeness?:string})?.completeness === 'complete') {
    try {
      const {pruneBackupHistoryAfterSave} = await import('./backupHistory');
      await pruneBackupHistoryAfterSave(record.id, record.raw, current);
    } catch { return {...record,cleanupWarning:'新しいバックアップは保存しましたが、古い分の整理を完了できませんでした。残ったコピーは保持しています。'}; }
  }
  return record;
}
export async function getSavedBackup(id: string): Promise<SavedBackup | undefined> {
  if (typeof indexedDB !== 'undefined') {
    await migrateSavedBackups().catch(() => undefined);
    const stored = await operation<SavedBackup | undefined>('readonly', (store) => store.get(id));
    if (stored) return stored;
  }
  const raw = localStorage.getItem(PREFIX + id);
  return raw ? JSON.parse(raw) as SavedBackup : undefined;
}
export async function listSavedBackups(): Promise<SavedBackupSummary[]> {
  const records: SavedBackupSummary[] = [];
  if (typeof indexedDB !== 'undefined') {
    await migrateSavedBackups().catch(() => undefined);
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('backups', 'readonly');
      const request = transaction.objectStore('backups').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        // Keep only the small list row. Never retain every backup body in memory.
        try {
          records.push(summarizeSavedBackup(cursor.value as SavedBackup));
          cursor.continue();
        } catch { transaction.abort(); }
      };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('バックアップを読み込めませんでした。')); };
    });
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) {
      try { const item = JSON.parse(localStorage.getItem(key) ?? 'null'); if (typeof item?.id === 'string' && typeof item.createdAt === 'string' && typeof item.raw === 'string' && !records.some((record) => record.id === item.id)) records.push(summarizeSavedBackup(item)); } catch { /* Keep unreadable originals untouched. */ }
    }
  }
  return records.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function deleteSavedBackup(id: string): Promise<void> {
  if (typeof indexedDB !== 'undefined') await operation('readwrite', (store) => store.delete(id));
  localStorage.removeItem(PREFIX + id);
}
