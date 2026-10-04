import type { AppOutboxOperation } from './appRecordStorage';
import {
  acknowledgeRecordPushBatch, bindRecordSyncConnection, freezeRecordPushBatch, getPendingRecordPushBatch, releaseRejectedRecordPushBatch,
  RecordSyncLocalChangedError,
  type RecordSyncConnection, type RecordPushAcknowledgement, type RecordPushBatch,
} from './recordSyncOutbox';
import {
  applyStagedRecordPull, getRecordPullCursor, stageRecordPullPage, validateRecordPullPage,
  type RecordConflict, type RecordPullApplyOptions,
} from './recordSyncPull';
import { recordSyncMetric } from './syncMetrics';
import { materialFileEntry } from './materialModel';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { remoteQuestionImageDescriptor } from './questionImageCloud';
import { SyncProtocolError } from './syncInterruption';

export interface RecordSyncTransport {
  pull(cursor: number): Promise<unknown>;
  push(operations: AppOutboxOperation[]): Promise<unknown>;
}
export type RecordSyncOutcome =
  | { status: 'done' | 'more' | 'deferred'; uploaded: number; downloaded: number }
  | { status: 'conflict'; conflicts: RecordConflict[]; uploaded: number; downloaded: number };
export type RecordSyncGuards = {
  /** Informational stages; observers must never affect persisted data. */
  step?(value: string): void;
  /** Re-check account, sync ID, import markers and pending-save failures. */
  assertCurrent(): Promise<void>;
  /** Hold the origin lock; protected screens may inspect without changing live data. */
  apply(operation: (options?: RecordPullApplyOptions) => ReturnType<typeof applyStagedRecordPull>): Promise<Awaited<ReturnType<typeof applyStagedRecordPull>> | null>;
  prepareMedia?(): Promise<void>;
};

/** Restartable bounded work. Network errors intentionally keep the frozen request and staged pages. */
export async function runRecordSync(
  db: IDBDatabase, connection: RecordSyncConnection, transport: RecordSyncTransport, guards: RecordSyncGuards,
  maxPages = 20, maxPushBatches = 20,
): Promise<RecordSyncOutcome> {
  const step = (value: string) => { try { guards.step?.(value); } catch { /* Informational only. */ } };
  let uploaded = 0;
  let downloaded = 0;
  const assertMediaReady = (operation: AppOutboxOperation) => {
    if (operation.raw === null) return;
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
  };
  const send = async (batch: RecordPushBatch): Promise<boolean> => {
    await guards.assertCurrent();
    batch.operations.forEach(assertMediaReady);
    recordSyncMetric('recordPushRequest', 0, new TextEncoder().encode(JSON.stringify(batch.operations)).byteLength);
    step('push');
    const value = await transport.push(batch.operations);
    await guards.assertCurrent();
    if (!value || typeof value !== 'object' || !('code' in value)) throw new SyncProtocolError('invalid_response', '差分同期の保存応答が不正です。');
    if (value.code === 'conflict') {
      await releaseRejectedRecordPushBatch(db, batch);
      return false;
    }
    if (value.code !== 'ok') throw new SyncProtocolError(typeof value.code === 'string' ? value.code : 'invalid_response', '差分保存の応答を確認できません。端末データと送信原本を保持しています。');
    step('push_ack');
    await acknowledgeRecordPushBatch(db, batch, value as RecordPushAcknowledgement);
    uploaded += batch.operations.length;
    return true;
  };
  await guards.assertCurrent();
  step('connection_bind');
  await bindRecordSyncConnection(db, connection);
  const pending = await getPendingRecordPushBatch(db, connection);
  // The server may have committed a lost response. Resolve it before merging a pull.
  if (pending) await send(pending);
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    await guards.assertCurrent();
    const cursor = await getRecordPullCursor(db, connection);
    step('pull');
    const response = await transport.pull(cursor);
    step('pull_validate');
    const page = validateRecordPullPage(response, cursor);
    await guards.assertCurrent();
    step('pull_stage');
    await stageRecordPullPage(db, connection, cursor, page);
    downloaded += page.batches.reduce((sum, batch) => sum + batch.changes.length, 0);
    if (page.hasMore) continue;
    step('pull_media');
    await guards.prepareMedia?.();
    step('pull_apply');
    const applied = await guards.apply(options => applyStagedRecordPull(db, connection, [], options));
    if (!applied) return { status: 'deferred', uploaded, downloaded };
    if (!applied.applied && 'conflicts' in applied) return { status: 'conflict', conflicts: applied.conflicts, uploaded, downloaded };
    if (!applied.applied) {
      if (applied.pushBlocked) return { status: 'deferred', uploaded, downloaded };
      // A complete, validated, conflict-free Pull is staged for later display.
      // Send one CAS batch, then re-inspect before sending any subsequent edits.
      // The receipt never advances the Pull cursor or the Snapshot baseline.
      await guards.assertCurrent();
      if (maxPushBatches < 1) return { status: 'more', uploaded, downloaded };
      let batch: RecordPushBatch | null;
      step('push_prepare');
      try { batch = await freezeRecordPushBatch(db, connection, { expectedCommitId: applied.commitId, validateOperation: assertMediaReady }); }
      catch (error) {
        if (error instanceof RecordSyncLocalChangedError) return { status: 'more', uploaded, downloaded };
        throw error;
      }
      if (!batch) return { status: 'deferred', uploaded, downloaded };
      await send(batch);
      return { status: 'more', uploaded, downloaded };
    }
    for (let batchNumber = 0; batchNumber < maxPushBatches; batchNumber++) {
      await guards.assertCurrent();
      let batch: RecordPushBatch | null;
      step('push_prepare');
      try { batch = await freezeRecordPushBatch(db, connection, {
        expectedCommitId: batchNumber === 0 ? applied.commitId : undefined, validateOperation: assertMediaReady,
      }); }
      catch (error) {
        if (error instanceof RecordSyncLocalChangedError) return { status: 'more', uploaded, downloaded };
        throw error;
      }
      if (!batch) return { status: 'done', uploaded, downloaded };
      if (!await send(batch)) return { status: 'more', uploaded, downloaded };
    }
    return { status: 'more', uploaded, downloaded };
  }
  return { status: 'more', uploaded, downloaded };
}
