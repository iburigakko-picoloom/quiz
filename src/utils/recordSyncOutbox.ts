import type { AppOutboxOperation, AppRecord, AppRecordState } from './appRecordStorage';
import { recordSyncMetric } from './syncMetrics';

export type RecordSyncConnection = { project: string; userId: string; syncId: string };
export type RecordPushBatch = { id: string; connection: RecordSyncConnection; operations: AppOutboxOperation[] };
export type RecordPushAcknowledgement = { code: 'ok'; revision: number; ack: Array<{ operationId: string; key: string; revision: number }> };
export const sameRecordSyncConnection = (a: RecordSyncConnection, b: RecordSyncConnection) =>
  a.project === b.project && a.userId === b.userId && a.syncId === b.syncId;

const MAX_BATCH_BYTES = 900 * 1024; // Leave room for JSON and RPC parameter framing.

export class RecordSyncLocalChangedError extends Error {
  constructor() { super('差分の検証後に端末データが更新されました。最新の変更を再確認します。'); }
}

/** Change only the wire representation of an unsent edit. Invalidate cached
 * snapshots atomically; never rewrite a request with an uncertain receipt.
 * The primary local bytes remain available for recovery.
 */
export async function commitPreparedRecordMedia(db: IDBDatabase, source: AppOutboxOperation, raw: string): Promise<boolean> {
  const tx = db.transaction(['appRecordMeta', 'appRecords', 'appOutbox'], 'readwrite');
  const completion = done(tx);
  let changed = false;
  const opRequest = tx.objectStore('appOutbox').get(source.key);
  const rowRequest = tx.objectStore('appRecords').get(source.key);
  const stateRequest = tx.objectStore('appRecordMeta').get('state');
  const frozen = tx.objectStore('appRecordMeta').get('pushBatch');
  frozen.onsuccess = () => {
    const op = opRequest.result as AppOutboxOperation | undefined;
    const row = rowRequest.result as AppRecord | undefined;
    const state = stateRequest.result as AppRecordState | undefined;
    if (frozen.result || !state || !op || op.operationId !== source.operationId
      || op.raw !== source.raw || row?.raw !== source.raw) return;
    tx.objectStore('appOutbox').put({ ...op, raw }, source.key);
    tx.objectStore('appRecords').put({ ...row, raw }, source.key);
    tx.objectStore('appRecordMeta').put({ ...state, commitId: crypto.randomUUID() }, 'state');
    changed = true;
  };
  await completion;
  return changed;
}

/** Server revisions are meaningful only within one account/project/sync ID. */
export async function bindRecordSyncConnection(db: IDBDatabase, connection: RecordSyncConnection): Promise<void> {
  if (!connection.project || !connection.userId || !connection.syncId) throw new Error('同期先の認証情報を確認できませんでした。');
  const check = db.transaction('appRecordMeta', 'readonly');
  const checked = done(check);
  const existing = check.objectStore('appRecordMeta').get('recordSyncConnection');
  await checked;
  if (existing.result) {
    if (!sameRecordSyncConnection(existing.result, connection)) throw new Error('端末の差分履歴は別の同期先に接続されています。Snapshotで同期先を確認してください。');
    return;
  }
  const tx = db.transaction('appRecordMeta', 'readwrite');
  const completion = done(tx);
  let failure: Error | undefined;
  const store = tx.objectStore('appRecordMeta');
  const binding = store.get('recordSyncConnection');
  const batch = store.get('pushBatch');
  const cursor = store.get('pullCursor');
  const stage = store.get('pullStage');
  stage.onsuccess = () => {
    const previous = [binding.result, batch.result?.connection, cursor.result?.connection, stage.result?.connection];
    if (previous.some(item => item && !sameRecordSyncConnection(item, connection))) {
      failure = new Error('端末の差分履歴は別の同期先に接続されています。Snapshotで同期先を確認してください。');
      tx.abort(); return;
    }
    if (!binding.result) store.put(connection, 'recordSyncConnection');
  };
  try { await completion; } catch (error) { throw failure ?? error; }
}

export async function getPendingRecordPushBatch(db: IDBDatabase, connection: RecordSyncConnection): Promise<RecordPushBatch | null> {
  const tx = db.transaction('appRecordMeta', 'readonly');
  const completion = done(tx);
  const request = tx.objectStore('appRecordMeta').get('pushBatch');
  await completion;
  const batch = request.result as RecordPushBatch | undefined;
  if (batch && !sameRecordSyncConnection(batch.connection, connection)) throw new Error('別の同期先への未確認送信があります。');
  return batch ?? null;
}

/** Only after an authoritative CAS rejection: the server committed none of this batch. */
export async function releaseRejectedRecordPushBatch(db: IDBDatabase, batch: RecordPushBatch): Promise<void> {
  const tx = db.transaction('appRecordMeta', 'readwrite');
  const completion = done(tx);
  const request = tx.objectStore('appRecordMeta').get('pushBatch');
  request.onsuccess = () => {
    if (request.result?.id !== batch.id) { tx.abort(); return; }
    tx.objectStore('appRecordMeta').delete('pushBatch');
  };
  await completion;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('差分同期の保存を完了できませんでした。'));
  });
}

/** Persist the exact request before network I/O; retries after restart reuse its IDs and bytes. */
export async function freezeRecordPushBatch(db: IDBDatabase, connection: RecordSyncConnection, options: {
  expectedCommitId?: string;
  validateOperation?: (operation: AppOutboxOperation) => void;
} = {}): Promise<RecordPushBatch | null> {
  await bindRecordSyncConnection(db, connection);
  const tx = db.transaction(['appRecordMeta', 'appOutbox'], 'readwrite');
  const completion = done(tx);
  let batch: RecordPushBatch | null = null;
  let failure: Error | undefined;
  const existing = tx.objectStore('appRecordMeta').get('pushBatch');
  const state = tx.objectStore('appRecordMeta').get('state');
  state.onsuccess = () => {
    if (existing.result) {
      const saved = existing.result as RecordPushBatch;
      if (!sameRecordSyncConnection(saved.connection, connection)) {
        failure = new Error('別の同期先への未確認送信があります。元の同期先で保存結果を確認してください。'); tx.abort(); return;
      }
      batch = saved;
      return;
    }
    if (options.expectedCommitId && state.result?.commitId !== options.expectedCommitId) {
      failure = new RecordSyncLocalChangedError(); tx.abort(); return;
    }
    const operations: AppOutboxOperation[] = [];
    let bytes = 2;
    const persist = () => {
      if (!operations.length) return;
      batch = { id: crypto.randomUUID(), connection, operations };
      tx.objectStore('appRecordMeta').put(batch, 'pushBatch');
    };
    // Bound IndexedDB reads as well as network bytes; a large offline queue
    // must not be cloned into memory for every 500-record request.
    const pending = tx.objectStore('appOutbox').openCursor();
    pending.onsuccess = () => {
      try {
        const cursor = pending.result;
        if (!cursor) { persist(); return; }
        // Ancestor evidence stays local; the wire request needs only the CAS revision.
        const { baseContent: _baseContent, ...operation } = cursor.value as AppOutboxOperation;
        // A new attachment can arrive after asynchronous Storage preparation.
        // Abort before persisting a batch so preparation can retry next run.
        options.validateOperation?.(operation);
        const size = new TextEncoder().encode(JSON.stringify(operation)).byteLength + 1;
        if (size > MAX_BATCH_BYTES) {
          failure = new Error('1レコードの同期サイズが大きすぎます。データは端末に保持しています。'); tx.abort(); return;
        }
        if (bytes + size > MAX_BATCH_BYTES) { persist(); return; }
        bytes += size; operations.push(operation);
        if (operations.length === 500) { persist(); return; }
        cursor.continue();
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
    };
  };
  try { await completion; } catch (error) { throw failure ?? error; }
  if (batch) recordSyncMetric('pushBatchFrozen');
  return batch;
}

function validateAcknowledgement(batch: RecordPushBatch, response: RecordPushAcknowledgement): void {
  if (response.code !== 'ok' || !Number.isSafeInteger(response.revision) || response.revision < 1
    || !Array.isArray(response.ack) || response.ack.length !== batch.operations.length) throw new Error('差分同期の保存応答が不正です。');
  const expected = new Map(batch.operations.map(op => [op.operationId, op]));
  for (const ack of response.ack) {
    const operation = expected.get(ack.operationId);
    if (!operation || operation.key !== ack.key || !Number.isSafeInteger(ack.revision)
      || ack.revision < 1 || ack.revision > response.revision || ack.revision <= operation.baseRevision) {
      throw new Error('差分同期の保存応答が送信内容と一致しません。');
    }
    expected.delete(ack.operationId);
  }
}

/** Acknowledge only sent IDs. Answers saved during upload stay in the outbox. */
export async function acknowledgeRecordPushBatch(
  db: IDBDatabase, batch: RecordPushBatch, response: RecordPushAcknowledgement,
): Promise<void> {
  validateAcknowledgement(batch, response);
  const tx = db.transaction(['appRecordMeta', 'appRecords', 'appOutbox'], 'readwrite');
  const completion = done(tx);
  let failure: Error | undefined;
  const current = tx.objectStore('appRecordMeta').get('pushBatch');
  current.onsuccess = () => {
    const saved = current.result as RecordPushBatch | undefined;
    if (!saved || saved.id !== batch.id || !sameRecordSyncConnection(saved.connection, batch.connection)
      || JSON.stringify(saved.operations) !== JSON.stringify(batch.operations)) {
      failure = new Error('送信中に同期先または送信内容が変わりました。'); tx.abort(); return;
    }
    const stateRequest = tx.objectStore('appRecordMeta').get('state');
    stateRequest.onsuccess = () => {
      const state = stateRequest.result as AppRecordState | undefined;
      if (!state) { failure = new Error('端末の保存Revisionが失われました。'); tx.abort(); return; }
      for (const ack of response.ack) {
        const rowRequest = tx.objectStore('appRecords').get(ack.key);
        const pendingRequest = tx.objectStore('appOutbox').get(ack.key);
        rowRequest.onsuccess = () => {
          const row = rowRequest.result as AppRecord | undefined;
          if (!row) { failure = new Error('送信した保存レコードが端末から失われました。'); tx.abort(); return; }
          tx.objectStore('appRecords').put({ ...row, serverRevision: Math.max(row.serverRevision, ack.revision) }, ack.key);
        };
        pendingRequest.onsuccess = () => {
          const pending = pendingRequest.result as AppOutboxOperation | undefined;
          if (!pending) return;
          if (pending.operationId === ack.operationId) tx.objectStore('appOutbox').delete(ack.key);
          else {
            // The remote now contains the sent ancestor of this newer edit.
            const sent = batch.operations.find(operation => operation.key === ack.key)!;
            tx.objectStore('appOutbox').put({ ...pending, baseRevision: Math.max(pending.baseRevision, ack.revision),
              baseContent: { raw: sent.raw, position: sent.position } }, ack.key);
          }
        };
      }
      tx.objectStore('appRecordMeta').put({ ...state, commitId: crypto.randomUUID() }, 'state');
      // Push receipt is not a Pull cursor: other devices' changes must still be read.
      tx.objectStore('appRecordMeta').put({ connection: batch.connection, revision: response.revision }, 'pushReceipt');
      tx.objectStore('appRecordMeta').delete('pushBatch');
    };
  };
  try { await completion; } catch (error) { throw failure ?? error; }
  recordSyncMetric('pushBatchAcknowledged');
}
