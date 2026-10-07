import type { AppOutboxOperation } from './appRecordStorage';
import { appRecordKey } from './appRecordStorage';
import { commitPreparedRecordMedia } from './recordSyncOutbox';
import { remoteQuestionImageDescriptor, storedQuestionImage, verifyQuestionImageBlob, type QuestionImageTransport } from './questionImageCloud';
import { validQuestionImageDescriptor, type QuestionImageDescriptor, type StoredQuestionImage } from './questionImageRecords';
import type { RemoteRecordChange } from './recordSyncPull';
import { recordSyncMetric } from './syncMetrics';
import type { SyncProgress } from './syncAttemptStatus';
function reportProgress(report:((value:SyncProgress)=>void)|undefined,label:string,completed:number,total:number|null){try{report?.({label,completed,total});}catch{/* Informational only. */}}

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
export async function prepareQuestionImageOutbox(db: IDBDatabase, transport: QuestionImageTransport, assertCurrent: () => Promise<void>, limit = 20,progress?:(value:SyncProgress)=>void): Promise<{ prepared: number; more: boolean }> {
  let prepared = 0;
  reportProgress(progress,'画像を送信中',0,null);
  for (; prepared < limit; prepared++) {
    const read = db.transaction(['appOutbox', 'appRecordMeta'], 'readonly');
    const complete = done(read);
    const frozen = read.objectStore('appRecordMeta').get('pushBatch');
    const cursor = read.objectStore('appOutbox').openCursor();
    let source: AppOutboxOperation | undefined;
    cursor.onsuccess = () => {
      const current = cursor.result; if (!current || frozen.result) return;
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
    await commitPreparedRecordMedia(db, sourceOp, JSON.stringify(remote));
    reportProgress(progress,'画像を送信中',prepared+1,null);
  }
  return { prepared, more: true };
}

/** Stage verified Blobs durably. A network or quota failure cannot move the Pull cursor. */
export async function prepareStagedQuestionImages(db: IDBDatabase, transport: QuestionImageTransport, assertCurrent: () => Promise<void>,progress?:(value:SyncProgress)=>void): Promise<void> {
  const read = db.transaction('appPullStage', 'readonly'); const complete = done(read);
  const incoming = read.objectStore('appPullStage').getAll();
  await complete;
  const rows=(incoming.result as RemoteRecordChange[]).filter(row=>row.collection==='questionImages'&&row.raw!==null);
  let count=0;reportProgress(progress,'画像を確認・受信中',0,rows.length);
  for (const row of rows) {
    const descriptor = parseQuestionImageDescriptor(row.raw);
    if (descriptor.id !== row.id || !descriptor.path || descriptor.path !== remoteQuestionImageDescriptor(descriptor, transport.userId).path) throw new Error('画像の差分参照が不正です。');
    const cacheTx = db.transaction(PULL_IMAGE_STORE, 'readonly'); const cacheDone = done(cacheTx);
    const cached = await request<{ key: string; revision: number; descriptor: QuestionImageDescriptor; image: StoredQuestionImage } | undefined>(cacheTx.objectStore(PULL_IMAGE_STORE).get(row.key)); await cacheDone;
    if (cached?.revision === row.revision && JSON.stringify(cached.descriptor) === JSON.stringify(descriptor) && await verifyQuestionImageBlob(cached.image.blob, descriptor)){reportProgress(progress,'画像を確認・受信中',++count,rows.length);continue;}
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
    reportProgress(progress,'画像を確認・受信中',++count,rows.length);
  }
}
