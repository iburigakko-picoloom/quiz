import type { AppOutboxOperation } from './appRecordStorage';
import {
  acknowledgeRecordPushBatch, bindRecordSyncConnection, freezeRecordPushBatch, getPendingRecordPushBatch, releaseRejectedRecordPushBatch,
  type RecordSyncConnection, type RecordPushAcknowledgement, type RecordPushBatch,
} from './recordSyncOutbox';
import {
  applyStagedRecordPull, getRecordPullCursor, stageRecordPullPage, validateRecordPullPage,
  type RecordConflict,
} from './recordSyncPull';
import { recordSyncMetric } from './syncMetrics';
import { materialFileEntry } from './materialModel';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { remoteQuestionImageDescriptor } from './questionImageCloud';

export interface RecordSyncTransport {
  pull(cursor: number): Promise<unknown>;
  push(operations: AppOutboxOperation[]): Promise<unknown>;
}
export type RecordSyncOutcome =
  | { status: 'done' | 'more' | 'deferred'; uploaded: number; downloaded: number }
  | { status: 'conflict'; conflicts: RecordConflict[]; uploaded: number; downloaded: number };
export type RecordSyncGuards = {
  /** Re-check account, sync ID, import markers and pending-save failures. */
  assertCurrent(): Promise<void>;
  /** Must acquire the UI/protected-work guard and origin data lock around apply. */
  apply(operation: () => ReturnType<typeof applyStagedRecordPull>): Promise<Awaited<ReturnType<typeof applyStagedRecordPull>> | null>;
  prepareMedia?(): Promise<void>;
};

/** Restartable bounded work. Network errors intentionally keep the frozen request and staged pages. */
export async function runRecordSync(
  db: IDBDatabase, connection: RecordSyncConnection, transport: RecordSyncTransport, guards: RecordSyncGuards,
  maxPages = 20, maxPushBatches = 20,
): Promise<RecordSyncOutcome> {
  let uploaded = 0;
  let downloaded = 0;
  const send = async (batch: RecordPushBatch): Promise<boolean> => {
    await guards.assertCurrent();
    for (const operation of batch.operations) {
      if (operation.raw === null) continue;
      if (operation.collection === 'questionImages') {
        const descriptor = parseQuestionImageDescriptor(operation.raw);
        if (descriptor.id !== operation.id || !descriptor.path
          || descriptor.path !== remoteQuestionImageDescriptor(descriptor, connection.userId).path) {
          throw new Error('画像本体の保存が未確認です。端末の画像を保持して送信を中止しました。');
        }
      }
      if (operation.collection === 'indexedDbNotes'
        && materialFileEntry(operation.id, operation.raw)?.kind === 'quiz-material-file') {
        throw new Error('PDF本体の保存が未確認です。端末の資料を保持して送信を中止しました。');
      }
    }
    recordSyncMetric('recordPushRequest', 0, new TextEncoder().encode(JSON.stringify(batch.operations)).byteLength);
    const value = await transport.push(batch.operations);
    await guards.assertCurrent();
    if (!value || typeof value !== 'object' || !('code' in value)) throw new Error('差分保存の応答が不正です。');
    if (value.code === 'conflict') {
      await releaseRejectedRecordPushBatch(db, batch);
      return false;
    }
    if (value.code !== 'ok') throw new Error(`差分保存を完了できませんでした (${String(value.code)})。端末データは保持しています。`);
    await acknowledgeRecordPushBatch(db, batch, value as RecordPushAcknowledgement);
    uploaded += batch.operations.length;
    return true;
  };
  await guards.assertCurrent();
  await bindRecordSyncConnection(db, connection);
  const pending = await getPendingRecordPushBatch(db, connection);
  // The server may have committed a lost response. Resolve it before merging a pull.
  if (pending) await send(pending);
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    await guards.assertCurrent();
    const cursor = await getRecordPullCursor(db, connection);
    const page = validateRecordPullPage(await transport.pull(cursor), cursor);
    await guards.assertCurrent();
    await stageRecordPullPage(db, connection, cursor, page);
    downloaded += page.batches.reduce((sum, batch) => sum + batch.changes.length, 0);
    if (page.hasMore) continue;
    await guards.prepareMedia?.();
    const applied = await guards.apply(() => applyStagedRecordPull(db, connection));
    if (!applied) return { status: 'deferred', uploaded, downloaded };
    if (!applied.applied) return { status: 'conflict', conflicts: applied.conflicts, uploaded, downloaded };
    for (let batchNumber = 0; batchNumber < maxPushBatches; batchNumber++) {
      await guards.assertCurrent();
      const batch = await freezeRecordPushBatch(db, connection);
      if (!batch) return { status: 'done', uploaded, downloaded };
      if (!await send(batch)) return { status: 'more', uploaded, downloaded };
    }
    return { status: 'more', uploaded, downloaded };
  }
  return { status: 'more', uploaded, downloaded };
}
