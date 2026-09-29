import type { AppOutboxOperation, AppRecord } from './appRecordStorage';
import { appRecordKey } from './appRecordStorage';
import { remoteQuestionImageDescriptor, storedQuestionImage, verifyQuestionImageBlob, type QuestionImageTransport } from './questionImageCloud';
import { validQuestionImageDescriptor, type QuestionImageDescriptor, type StoredQuestionImage } from './questionImageRecords';
import type { RemoteRecordChange } from './recordSyncPull';
import { recordSyncMetric } from './syncMetrics';

export const PULL_IMAGE_STORE = 'appPullMedia';
function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('画像の同期状態を保存できませんでした。')); }); }
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
export function parseQuestionImageDescriptor(raw: string | null): QuestionImageDescriptor {
  if (raw === null) throw new Error('画像の削除情報は画像本体を持ちません。');
  const value: unknown = JSON.parse(raw);
  if (!validQuestionImageDescriptor(value)) throw new Error('画像の差分情報が不正です。');
  return value;
}

/** Upload body before allowing metadata into a frozen RPC batch. */
export async function prepareQuestionImageOutbox(db: IDBDatabase, transport: QuestionImageTransport, assertCurrent: () => Promise<void>, limit = 20): Promise<{ prepared: number; more: boolean }> {
  let prepared = 0;
  for (; prepared < limit; prepared++) {
    const read = db.transaction(['appOutbox', 'appRecordMeta'], 'readonly');
    const complete = done(read);
    const frozen = read.objectStore('appRecordMeta').get('pushBatch');
    const cursor = read.objectStore('appOutbox').openCursor();
    let source: AppOutboxOperation | undefined;
    cursor.onsuccess = () => {
      const current = cursor.result; if (!current) return;
      const op = current.value as AppOutboxOperation;
      if (op.collection === 'questionImages' && op.raw !== null) {
        const value = parseQuestionImageDescriptor(op.raw);
        if (!value.path) { source = op; return; }
      }
      current.continue();
    };
    await complete;
    if (frozen.result) return { prepared, more: false }; // First resolve an uncertain server receipt.
    if (!source) return { prepared, more: false };
    const sourceOp = source;
    const descriptor = parseQuestionImageDescriptor(sourceOp.raw);
    const bodyTx = db.transaction('questionImageBlobs', 'readonly'); const bodyDone = done(bodyTx);
    const body = await request<StoredQuestionImage | undefined>(bodyTx.objectStore('questionImageBlobs').get(sourceOp.id)); await bodyDone;
    if (!body || body.id !== descriptor.id || body.questionId !== descriptor.questionId || !await verifyQuestionImageBlob(body.blob, descriptor)) throw new Error('画像本体を確認できないため差分保存を中止しました。端末データは保持しています。');
    const remote = remoteQuestionImageDescriptor(descriptor, transport.userId);
    await assertCurrent();
    if (!await transport.exists(remote)) { await transport.upload(remote, body.blob); recordSyncMetric('questionImageUpload', 0, body.blob.size); }
    await assertCurrent();
    const change = db.transaction(['appRecords', 'appOutbox'], 'readwrite'); const changed = done(change);
    const currentOp = change.objectStore('appOutbox').get(sourceOp.key);
    const currentRow = change.objectStore('appRecords').get(sourceOp.key);
    currentRow.onsuccess = () => {
      const op = currentOp.result as AppOutboxOperation | undefined;
      const row = currentRow.result as AppRecord | undefined;
      if (!op || op.operationId !== sourceOp.operationId || op.raw !== sourceOp.raw || row?.raw !== sourceOp.raw) { change.abort(); return; }
      const raw = JSON.stringify(remote);
      change.objectStore('appOutbox').put({ ...op, raw }, sourceOp.key);
      change.objectStore('appRecords').put({ ...row, raw }, sourceOp.key);
    };
    await changed;
  }
  return { prepared, more: true };
}

/** Stage verified Blobs durably. A network or quota failure cannot move the Pull cursor. */
export async function prepareStagedQuestionImages(db: IDBDatabase, transport: QuestionImageTransport, assertCurrent: () => Promise<void>): Promise<void> {
  const read = db.transaction('appPullStage', 'readonly'); const complete = done(read);
  const incoming = read.objectStore('appPullStage').getAll();
  await complete;
  for (const row of incoming.result as RemoteRecordChange[]) {
    if (row.collection !== 'questionImages' || row.raw === null) continue;
    const descriptor = parseQuestionImageDescriptor(row.raw);
    if (descriptor.id !== row.id || !descriptor.path || descriptor.path !== remoteQuestionImageDescriptor(descriptor, transport.userId).path) throw new Error('画像の差分参照が不正です。');
    const cacheTx = db.transaction(PULL_IMAGE_STORE, 'readonly'); const cacheDone = done(cacheTx);
    const cached = await request<{ key: string; revision: number; descriptor: QuestionImageDescriptor; image: StoredQuestionImage } | undefined>(cacheTx.objectStore(PULL_IMAGE_STORE).get(row.key)); await cacheDone;
    if (cached?.revision === row.revision && JSON.stringify(cached.descriptor) === JSON.stringify(descriptor) && await verifyQuestionImageBlob(cached.image.blob, descriptor)) continue;
    const localTx = db.transaction('questionImageBlobs', 'readonly'); const localDone = done(localTx);
    const existing = await request<StoredQuestionImage | undefined>(localTx.objectStore('questionImageBlobs').get(row.id)); await localDone;
    const reused = Boolean(existing && await verifyQuestionImageBlob(existing.blob, descriptor));
    const blob = reused ? existing!.blob : await transport.download(descriptor);
    if (!reused) recordSyncMetric('questionImageDownload', 0, blob.size);
    if (!await verifyQuestionImageBlob(blob, descriptor)) throw new Error('画像の内容を検証できませんでした。');
    await assertCurrent();
    const tx = db.transaction(PULL_IMAGE_STORE, 'readwrite'); const saved = done(tx);
    tx.objectStore(PULL_IMAGE_STORE).put({ key: appRecordKey('questionImages', row.id), revision: row.revision, descriptor, image: storedQuestionImage(descriptor, blob) }, row.key);
    await saved;
  }
}
