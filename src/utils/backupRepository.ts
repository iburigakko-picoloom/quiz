import type { SyncPayload } from './syncService';

export interface SavedBackup { id: string; createdAt: string; kind: 'manual' | 'before-import' | 'before-sync' | 'before-logout'; raw: string; }
const DB = 'quiz-make-backups';
// Durable backups must not be matched by legacy temporary-backup cleanup.
const PREFIX = 'quizMake:sync:saved-backup:';
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('backups', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('バックアップ保存領域を開けません。別のタブを閉じて再試行してください。'));
  });
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
export async function saveBackupPayload(payload: SyncPayload, kind: SavedBackup['kind']): Promise<SavedBackup> {
  const record: SavedBackup = { id: `backup-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), kind, raw: JSON.stringify(payload) };
  if (typeof indexedDB === 'undefined') localStorage.setItem(PREFIX + record.id, JSON.stringify(record));
  else await operation('readwrite', (store) => store.add(record));
  const checked = await getSavedBackup(record.id);
  if (!checked || checked.raw !== record.raw) throw new Error('バックアップの読み戻しを確認できませんでした。');
  return record;
}
export async function getSavedBackup(id: string): Promise<SavedBackup | undefined> {
  if (typeof indexedDB !== 'undefined') {
    const stored = await operation<SavedBackup | undefined>('readonly', (store) => store.get(id));
    if (stored) return stored;
  }
  const raw = localStorage.getItem(PREFIX + id);
  return raw ? JSON.parse(raw) as SavedBackup : undefined;
}
export async function listSavedBackups(): Promise<SavedBackup[]> {
  const records: SavedBackup[] = typeof indexedDB !== 'undefined' ? await operation('readonly', (store) => store.getAll()) : [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) {
      try { const item = JSON.parse(localStorage.getItem(key) ?? 'null'); if (typeof item?.id === 'string' && typeof item.createdAt === 'string' && typeof item.raw === 'string' && !records.some((record) => record.id === item.id)) records.push(item); } catch { /* Keep unreadable originals untouched. */ }
    }
  }
  return records.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function deleteSavedBackup(id: string): Promise<void> {
  if (typeof indexedDB !== 'undefined') await operation('readwrite', (store) => store.delete(id));
  localStorage.removeItem(PREFIX + id);
}
