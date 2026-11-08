import { accountDatabaseName, assertAccountNetworkCurrent, assertAccountStorageCurrent, type LocalAccountIdentity } from './accountStorage';

export type ManualActivity = { id: string; groupId: string; generation: string; title: string; answered: number | null; minutes: number; finishedAt: string };
export type ManualActivityItem = { row: ManualActivity; status: 'pending' | 'rejected' };

/** Separate from learning sync and the automatic-session queue. */
export function manualActivityOutbox(identity: LocalAccountIdentity) {
  const scope = `${identity.project}/${identity.userId}`;
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    assertAccountStorageCurrent(identity);
    const request = indexedDB.open(accountDatabaseName('quiz-make-manual-activity-outbox-v1'), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const transact = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, set: (value: T) => void) => void) => {
    const db = await open(); assertAccountStorageCurrent(identity);
    try { return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('events', mode); let value: T;
      tx.oncomplete = () => { try { assertAccountStorageCurrent(identity); resolve(value); } catch (error) { reject(error); } };
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('活動を端末に保存できません。'));
      try { operation(tx.objectStore('events'), next => { value = next; }); } catch (error) { tx.abort(); reject(error); }
    }); } finally { db.close(); }
  };
  return {
    put: (row: ManualActivity) => transact<void>('readwrite', (store, set) => {
      const key = `${scope}/${row.id}`, request = store.get(key);
      request.onsuccess = () => {
        if (request.result) {
          if (JSON.stringify(request.result.row) !== JSON.stringify(row)) { store.transaction.abort(); return; }
        } else store.add({ key, scope, row, status: 'pending' });
        set(undefined);
      };
    }),
    list: () => transact<ManualActivityItem[]>('readonly', (store, set) => { const request = store.getAll(); request.onsuccess = () => set(request.result.filter(item => item.scope === scope).map(({row,status}) => ({row,status}))); }),
    remove: (id: string) => transact<void>('readwrite', (store, set) => { store.delete(`${scope}/${id}`); set(undefined); }),
    reject: (row: ManualActivity) => transact<void>('readwrite', (store, set) => { store.put({ key: `${scope}/${row.id}`, scope, row, status: 'rejected' }); set(undefined); }),
  };
}

const running = new Map<string, Promise<void>>();
export function drainManualActivities(identity: LocalAccountIdentity, send: (row: ManualActivity) => Promise<boolean>) {
  const key = `${identity.project}/${identity.userId}`;
  if (running.has(key)) return running.get(key)!;
  const work = (async () => {
    const box = manualActivityOutbox(identity);
    for (;;) {
      const batch = (await box.list()).filter(item => item.status === 'pending');
      if (!batch.length) break;
      let failed: unknown;
      for (const {row} of batch) {
        try {
          assertAccountNetworkCurrent(identity); const accepted = await send(row); assertAccountStorageCurrent(identity);
          if (accepted === true) await box.remove(row.id); else if (accepted === false) await box.reject(row); else throw new Error('共有結果を確認できません。');
        } catch (error) { failed ??= error; }
      }
      if (failed) throw failed;
    }
  })().finally(() => running.delete(key));
  running.set(key, work); return work;
}
