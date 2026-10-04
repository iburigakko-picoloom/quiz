import { AccountStorageSession, decideAccountStorage, sameLocalAccount, validateLocalAccountIdentity, type LocalAccountIdentity } from './accountStorage';
import { withCoordinatedDataRead } from './dataCoordination';

export type StoredAccountBinding = LocalAccountIdentity & { syncId: string };
function binding(value: unknown): StoredAccountBinding {
  const identity = validateLocalAccountIdentity(value);
  const syncId = (value as { syncId?: unknown }).syncId;
  if (typeof syncId !== 'string' || !/^[a-f0-9]{36}$/u.test(syncId)) throw new Error('既存の同期接続を確認できません。元のデータは保持しています。');
  return { ...identity, syncId };
}
/** Reads only ownership metadata. Never upgrades an old DB or loads its blobs,
 * changes cursor/operation IDs, clears an outbox, or creates a missing store. */
export async function readStoredAccountBinding(factory: IDBFactory, databaseName: string): Promise<StoredAccountBinding | null> {
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = factory.open(databaseName);
    let absent = false;
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort(); };
    request.onerror = () => absent ? resolve(null) : reject(request.error ?? new Error('保存済みの所有記録を読み込めません。'));
    request.onblocked = () => reject(new Error('端末の所有記録を読み込めません。別のQuizMake画面を閉じて再試行してください。'));
    request.onsuccess = () => resolve(request.result);
  });
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains('appRecordMeta')) return null;
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('appRecordMeta', 'readonly'), store = tx.objectStore('appRecordMeta');
      const requests = ['recordSyncConnection','pushBatch','pullCursor','pullStage'].map(key => store.get(key));
      tx.oncomplete = () => resolve(requests.map((request, index) => index === 0 ? request.result : request.result?.connection));
      tx.onabort = () => reject(tx.error ?? new Error('保存済みの所有記録を読み込めません。'));
    });
    const connections = values.filter(value => value !== undefined && value !== null).map(binding);
    if (!connections.length) return null;
    if (connections.some(value => !sameLocalAccount(value, connections[0]) || value.syncId !== connections[0].syncId)) throw new Error('既存の同期接続に異なる所有記録があります。元のデータは保持しています。');
    return connections[0];
  } finally { db.close(); }
}

export async function initializeAccountStorage(identity: LocalAccountIdentity | null): Promise<AccountStorageSession> {
  // The same lock is used by old application writers. Ownership is established
  // before mounting App, so no cached global DB can be retargeted mid-operation.
  return withCoordinatedDataRead([], async () => {
    const previous = typeof indexedDB === 'undefined' ? null : await readStoredAccountBinding(indexedDB, 'quiz-make-app-data-v1');
    return new AccountStorageSession(globalThis.localStorage, decideAccountStorage(globalThis.localStorage, identity, previous));
  }, { requireCrossContext: true });
}
