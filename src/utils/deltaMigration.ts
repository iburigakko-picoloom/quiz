import { acknowledgeRecordPushBatch, bindRecordSyncConnection, getPendingRecordPushBatch, releaseRejectedRecordPushBatch, type RecordPushAcknowledgement, type RecordSyncConnection } from './recordSyncOutbox';
import { acknowledgeWholeUpload, readWholeMeta, releaseWholeUpload, type WholeFrozen } from './wholeSyncStorage';
import { readMeta, writeMeta } from './blobVault';
import { clearDeltaCheckpoint, runDeltaSync, type DeltaTransport } from './deltaSync';
import type { RecordSyncGuards, RecordSyncOutcome } from './recordSyncEngine';
import type { WholeTransport } from './wholeSyncEngine';
import { getSyncDevice } from './syncDevice';
import { accountLocalStorage } from './accountStorage';

/** Enable only after a complete pinned checkpoint has been verified locally.
 * Original legacy snapshots and receipts stay on the server for recovery. */
export async function prepareDeltaSync(db: IDBDatabase, connection: RecordSyncConnection, transport: DeltaTransport & WholeTransport, guards: RecordSyncGuards): Promise<RecordSyncOutcome | null> {
  await bindRecordSyncConnection(db, connection); await guards.assertCurrent();
  const status = await transport.delta('status', { deviceId: JSON.parse(getSyncDevice()).id });
  if (status.code !== 'ok') throw new Error(`同期方式を確認できません（${status.code}）。旧データを保持しています。`);
  const whole = await readWholeMeta<WholeFrozen>(db, 'wholeFrozen', connection);
  if (whole) {
    // Abort is also an authoritative receipt lookup. It cannot undo a commit.
    const result = await transport.whole('abort', { p_operation_id: whole.id }); await guards.assertCurrent();
    if (result.code === 'committed' && Number.isSafeInteger(result.revision)) await acknowledgeWholeUpload(db, whole, result.revision as number);
    else if (result.code === 'not_committed') {
      await writeMeta(db, `legacyResolved:${whole.id}`, { connection, operationId: whole.id, resolved: 'not_committed', frozen: whole });
      await releaseWholeUpload(db, whole);
    } else throw new Error('旧方式の送信結果を確認中です。送信原本を保持しています。');
    return { status: 'more', uploaded: 0, downloaded: 0 };
  }
  const old = await getPendingRecordPushBatch(db, connection);
  if (old) {
    const head = await transport.whole('status');
    if (!status.enabled && !head.enabled) { const opened = await transport.whole('open', { p_expected_revision: head.revision }); if (opened.code !== 'ok') return { status: 'more', uploaded: 0, downloaded: 0 }; }
    const result = await transport.whole('receipts', { p_operations: old.operations }); await guards.assertCurrent();
    if (result.code === 'ok') await acknowledgeRecordPushBatch(db, old, result as RecordPushAcknowledgement);
    else if (result.code === 'not_committed') { await writeMeta(db, `legacyResolved:${old.id}`, { ...old, resolved: 'not_committed' }); await releaseRejectedRecordPushBatch(db, old); }
    else throw new Error('旧方式の送信結果を確認中です。送信原本を保持しています。');
  }
  if (!status.enabled) {
    const bootstrap = await runDeltaSync(db, connection, transport, guards, true);
    if (bootstrap.status !== 'done') return bootstrap;
    const cursor = await readMeta<{ revision: number }>(db, 'deltaCursor');
    guards.step?.('finalizing');
    try{guards.progress?.({stage:'finalizing',label:'旧データの引き継ぎを確定中',completed:0,total:1});}catch{/* Informational only. */}
    const enabled = await transport.delta('enable', { revision: cursor?.revision }); await guards.assertCurrent();
    if (enabled.code === 'conflict') { await writeMeta(db, 'deltaCursor', undefined); await clearDeltaCheckpoint(db); return { status: 'more', uploaded: 0, downloaded: 0 }; }
    if (enabled.code === 'legacy_pending') return { status: 'more', uploaded: 0, downloaded: 0 };
    if (enabled.code !== 'ok') throw new Error('引き継ぎの検証が完了していません。元データを保持しています。');
  }
  await writeMeta(db, 'deltaEnabled', { version: 3, connection });
  accountLocalStorage.setItem('quizMake:sync:deltaRequired',connection.syncId);
  if (!await readMeta(db, 'deltaFrozen')) await writeMeta(db, 'deltaSequence', Math.max(await readMeta<number>(db, 'deltaSequence') ?? 0, Number(status.sequence) || 0));
  // Keep legacy recovery evidence, but do not let an obsolete whole-snapshot
  // prompt block independent V3 edits after the canonical checkpoint is verified.
  for (const key of ['wholeConflict', 'wholeIncoming', 'pullStage']) {
    const legacy = await readMeta(db, key);
    if (legacy) { await writeMeta(db, `legacyPreserved:${key}`, legacy); await writeMeta(db, key, undefined); }
  }
  return null;
}
