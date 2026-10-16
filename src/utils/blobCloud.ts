import { getCloudAccessToken } from './cloudService';
import { getRemoteSyncConfig } from './syncService';
import { getAccountStorageSession } from './accountStorage';
import { openAppDb } from '../storage';
import { getContentBlob, idbDone, idbResult, putContentBlob, type BlobRef, type BlobMeta } from './blobVault';
export const CONTENT_BUCKET = 'quiz-content-blobs';
async function access() {
  const config = getRemoteSyncConfig(), token = await getCloudAccessToken();
  if (!config || !token.ok) throw new Error('資料の取得・転送にはログインが必要です。');
  return { config, token };
}
export async function downloadContentBlob(ref: BlobRef): Promise<Blob> {
  const owner = getAccountStorageSession(), { config, token } = await access();
  const response = await fetch(`${config.url}/storage/v1/object/${CONTENT_BUCKET}/${token.userId}/${ref.sha256}`, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('資料はまだ転送中か、通信できません。保存元の端末の同期後に再試行してください。');
  const reader = response.body?.getReader(); if (!reader) throw new Error('本文を受信できません。');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > ref.size) throw new Error('本文のサイズが一致しません。'); chunks.push(new Uint8Array(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  if (owner !== getAccountStorageSession()) throw new Error('アカウントが変わりました。'); owner?.assertCurrent();
  const blob = new Blob(chunks, { type: ref.type });
  await putContentBlob(await openAppDb(), blob, { expected: ref, origin: 'remote' }); return blob;
}
const uploads = new WeakMap<IDBDatabase, Promise<void>>();
/** A separate queue; callers never await PDF transfers on the learning sync path. */
export function startBlobTransfers(db: IDBDatabase, assertCurrent: () => Promise<void>): void {
  if (uploads.has(db)) return;
  const task = (async () => {
    const tx = db.transaction('contentBlobJobs', 'readonly'), done = idbDone(tx);
    const refs = await idbResult<BlobRef[]>(tx.objectStore('contentBlobJobs').getAll()); await done;
    for (const ref of refs) {
      await assertCurrent(); const { config, token } = await access();
      const blob = await getContentBlob(db, ref); if (!blob) throw new Error('未送信の本文が見つかりません。');
      const path = `${token.userId}/${ref.sha256}`;
      const headers = { apikey: config.anonKey, Authorization: `Bearer ${token.accessToken}` };
      const exists = async () => {
        const response = await fetch(`${config.url}/storage/v1/object/${CONTENT_BUCKET}/${path}`, { method: 'HEAD', headers, signal: AbortSignal.timeout(30000) });
        if (response.ok) return true; if ([400, 404].includes(response.status)) return false; throw new Error('資料の保存先を確認できません。');
      };
      if (!await exists()) {
        const { Upload } = await import('tus-js-client');
        await new Promise<void>((resolve, reject) => {
          let timeout: ReturnType<typeof setTimeout>;
          const finish = (error?: unknown) => { clearTimeout(timeout); if (error) reject(error); else resolve(); };
          const upload = new Upload(blob, {
            endpoint: config.url.replace('.supabase.co', '.storage.supabase.co') + '/storage/v1/upload/resumable',
            headers, chunkSize: 6 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000], uploadDataDuringCreation: true, removeFingerprintOnSuccess: true,
            fingerprint: async () => `${config.url}/${CONTENT_BUCKET}/${path}`,
            metadata: { bucketName: CONTENT_BUCKET, objectName: path, contentType: ref.type, cacheControl: '31536000' },
            onBeforeRequest: async request => { await assertCurrent(); const fresh = await getCloudAccessToken(); if (!fresh.ok || fresh.userId !== token.userId) throw new Error('資料のアカウントが変わりました。'); request.setHeader('Authorization', `Bearer ${fresh.accessToken}`); },
            onSuccess: () => finish(), onError: () => { void exists().then(found => finish(found ? undefined : new Error('資料の転送を再試行します。')), finish); },
          });
          timeout = setTimeout(() => { void upload.abort(false); finish(new Error('資料の転送を再開します。')); }, 300000);
          void upload.findPreviousUploads().then(previous => { if (previous[0]) upload.resumeFromPreviousUpload(previous[0]); upload.start(); }, finish);
        });
      }
      await assertCurrent();
      const write = db.transaction(['contentBlobJobs', 'contentBlobMeta', 'contentBlobRefs'], 'readwrite'), committed = idbDone(write);
      write.objectStore('contentBlobJobs').delete(ref.sha256); write.objectStore('contentBlobRefs').delete(`upload:${ref.sha256}`);
      const meta = write.objectStore('contentBlobMeta').get(ref.sha256);
      meta.onsuccess = () => { if (meta.result) write.objectStore('contentBlobMeta').put({ ...meta.result, uploaded: true } satisfies BlobMeta, ref.sha256); };
      await committed;
    }
  })().catch(() => { /* Persistent jobs and originals survive network/account/quota failures. */ }).finally(() => uploads.delete(db));
  uploads.set(db, task);
}
