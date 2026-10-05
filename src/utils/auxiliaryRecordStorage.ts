import { appRecordKey, type AppRecord, type AppRecordState, type AppOutboxOperation } from './appRecordStorage';
import { chunkIds, parseChunkManifest } from './recordChunkFormat';
import { queueUserEditGeneration } from './userEditGeneration';

export const NOTE_CURRENT_STORE = 'categoryNotes';
export const NOTE_BACKUP_STORE = 'categoryNoteBackups';
export const NOTE_RECORD_TRANSACTION_STORES = [NOTE_CURRENT_STORE, NOTE_BACKUP_STORE, 'appRecordMeta', 'appRecords', 'appRecordBackups', 'appOutbox'];
const transactionStates = new WeakMap<IDBTransaction, { request: IDBRequest; changed: boolean }>();
const activeTransactions = new Set<IDBTransaction>();
let operationEpoch = 0;
export const noteOperationEpoch = () => operationEpoch;
export function assertNoteOperationEpoch(epoch: number): void {
  if (epoch !== operationEpoch) throw new Error('ノート保存がタイムアウトしたため、遅れて到着した保存を中止しました。');
}
export function trackNoteTransaction(tx: IDBTransaction): void {
  if (activeTransactions.has(tx)) return;
  activeTransactions.add(tx);
  const release = () => activeTransactions.delete(tx);
  tx.addEventListener?.('complete', release, { once: true });
  tx.addEventListener?.('abort', release, { once: true });
}
export function abortPendingNoteTransactions(): void {
  operationEpoch++;
  for (const tx of activeTransactions) { try { tx.abort(); } catch { /* Already completed. */ } }
  activeTransactions.clear();
}

/** Queue one auxiliary value in the same transaction as its primary store write.
 * The revision is shared by every note in this transaction.
 */
export function queueNoteRecordWrite(tx: IDBTransaction, id: string, raw: string | null, userEdit=true): void {
  queueAuxiliaryRecordWrite(tx, 'indexedDbNotes', id, raw,userEdit);
}
export function rememberChunkGarbage(tx: IDBTransaction, old: AppRecord | undefined): void {
  const manifest=old&&parseChunkManifest(old.raw,old.collection,old.id);
  if(manifest)tx.objectStore('appRecordMeta').put({parentKey:old!.key,ids:chunkIds(manifest)},'chunkGc:'+manifest.parentHash+':'+manifest.version);
}
export function queueAuxiliaryRecordWrite(tx: IDBTransaction, collection: 'indexedDbNotes' | 'localStorage' | 'questionImages', id: string, raw: string | null, userEdit=true): void {
  trackNoteTransaction(tx);
  const meta = tx.objectStore('appRecordMeta');
  let shared = transactionStates.get(tx);
  if (!shared) { shared = { request: meta.get('state'), changed: false }; transactionStates.set(tx, shared); }
  const stateRequest = shared.request;
  const key = appRecordKey(collection, id);
  const pendingRequest = tx.objectStore('appOutbox').get(key);
  const oldRequest = tx.objectStore('appRecords').get(key);
  oldRequest.onsuccess = () => {
    try {
      const state = stateRequest.result as AppRecordState | undefined;
      const old = oldRequest.result as AppRecord | undefined;
      if (!state) throw new Error('問題データのレコード移行が完了していません。');
      if ((old && (old.logicalRaw ?? old.raw) === raw) || (!old && raw === null)) return;
      if(userEdit)queueUserEditGeneration(tx);
      rememberChunkGarbage(tx,old);
      const revision = state.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('保存Revisionの上限に達しました。');
      const row: AppRecord = { key, collection, id, raw, position: 0, localRevision: revision, serverRevision: old?.serverRevision ?? 0 };
      const operation: AppOutboxOperation = { ...row, operationId: crypto.randomUUID(), baseRevision: row.serverRevision };
      const prior = pendingRequest.result as AppOutboxOperation | undefined;
      const baseContent = prior
        ? (prior.baseRevision === row.serverRevision ? prior.baseContent : undefined)
        : old && old.serverRevision > 0 ? { raw: old.raw, position: old.position } : undefined;
      if (baseContent) operation.baseContent = baseContent;
      if (old) tx.objectStore('appRecordBackups').put({ ...old, replacedAt: revision }, key);
      tx.objectStore('appRecords').put(row, key);
      tx.objectStore('appOutbox').put(operation, key);
      if (collection === 'indexedDbNotes' && raw && /"kind"\s*:\s*"quiz-material-(?:remote-)?file"/u.test(raw)) {
        meta.put(1, 'recordMediaPresent');
      }
      if (!shared.changed) {
        meta.put(state, 'previousState');
        meta.put({ ...state, revision, commitId: crypto.randomUUID(), savedAt: new Date().toISOString() }, 'state');
        shared.changed = true;
      }
    } catch { tx.abort(); }
  };
}
