import { MATERIAL_BUCKET, materialFileEntry, type MaterialFile, type RemoteMaterialFile } from './materialModel';
import type { SyncPayload } from './syncService';

export interface MaterialTransport {
  userId: string;
  /** In-memory scope, including project and authenticated session. Never persisted. */
  cacheScope?: string;
  exists(file: RemoteMaterialFile): Promise<boolean>;
  upload(file: RemoteMaterialFile, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  download(file: RemoteMaterialFile): Promise<Uint8Array<ArrayBuffer>>;
}
// Only verified immutable PDF content is reused. Metadata/RPC authorization is still
// fetched on every sync, and a different session immediately clears this cache.
const MAX_CACHED_CHARACTERS = 24 * 1024 * 1024;
const verifiedPdfs = new Map<string, string>();
let cachedCharacters = 0;
let cacheScope: string | undefined;
function selectCacheScope(scope: string | undefined) {
  if (!scope || cacheScope !== scope) {
    verifiedPdfs.clear();
    cachedCharacters = 0;
    cacheScope = scope;
  }
}
function cachePdf(key: string, dataUrl: string) {
  if (dataUrl.length > MAX_CACHED_CHARACTERS) return;
  const previous = verifiedPdfs.get(key);
  if (previous) cachedCharacters -= previous.length;
  verifiedPdfs.delete(key);
  while (cachedCharacters + dataUrl.length > MAX_CACHED_CHARACTERS) {
    const oldest = verifiedPdfs.keys().next().value;
    if (!oldest) break;
    cachedCharacters -= verifiedPdfs.get(oldest)!.length;
    verifiedPdfs.delete(oldest);
  }
  verifiedPdfs.set(key, dataUrl);
  cachedCharacters += dataUrl.length;
}
const fileEntries = (payload: SyncPayload) => [payload.localStorage, payload.indexedDbNotes ?? {}]
  .flatMap(entries => Object.entries(entries).map(([key, raw]) => materialFileEntry(key, raw))).filter(file => file !== null);
export const hasMaterialFiles = (payload: SyncPayload) => fileEntries(payload).length > 0;
export const hasRemoteMaterialFiles = (payload: SyncPayload) => [payload.localStorage, payload.indexedDbNotes ?? {}]
  .some(entries => Object.values(entries).some(raw => { try { return JSON.parse(raw)?.kind === 'quiz-material-remote-file'; } catch { return false; } }));

function decodePdf(dataUrl: string) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Comparison only: replace PDF bodies/remote pointers with the same content digest.
 * The result is deliberately not an importable/uploadable material snapshot. */
export async function materialComparisonPayload(payload: SyncPayload): Promise<SyncPayload> {
  const map = async (entries: Record<string, string>) => {
    const result = { ...entries };
    for (const [key, raw] of Object.entries(entries)) {
      const file = materialFileEntry(key, raw);
      if (!file) continue;
      const sha256 = file.kind === 'quiz-material-file' ? await digest(decodePdf(file.dataUrl)) : file.sha256;
      result[key] = JSON.stringify({ kind: 'quiz-material-comparison', materialId: file.materialId, updatedAt: file.updatedAt, sha256 });
    }
    return result;
  };
  return { ...payload, localStorage: await map(payload.localStorage), indexedDbNotes: await map(payload.indexedDbNotes ?? {}) };
}
function encodePdf(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return 'data:application/pdf;base64,' + btoa(parts.join(''));
}
async function mapFiles(payload: SyncPayload, transform: (file: MaterialFile | RemoteMaterialFile) => Promise<MaterialFile | RemoteMaterialFile>) {
  const map = async (entries: Record<string, string>) => {
    const result = { ...entries };
    // Sequential processing bounds memory and avoids bursts of large uploads.
    for (const [key, raw] of Object.entries(entries)) {
      const file = materialFileEntry(key, raw);
      if (file) result[key] = JSON.stringify(await transform(file));
    }
    return result;
  };
  return { ...payload, localStorage: await map(payload.localStorage), indexedDbNotes: await map(payload.indexedDbNotes ?? {}) };
}

/** Upload immutable, content-addressed files first. Never mutate the local snapshot. */
export async function prepareMaterialUpload(payload: SyncPayload, transport: MaterialTransport): Promise<SyncPayload> {
  const checked = new Set<string>();
  return mapFiles(payload, async file => {
    if (file.kind !== 'quiz-material-file') throw new Error('PDF本体が未取得のため保存を中止しました。先にクラウドから読み込んでください。');
    const bytes = decodePdf(file.dataUrl);
    const sha256 = await digest(bytes);
    const remote: RemoteMaterialFile = { kind: 'quiz-material-remote-file', version: 1, materialId: file.materialId,
      updatedAt: file.updatedAt, bucket: MATERIAL_BUCKET, path: `${transport.userId}/${sha256}.pdf`, sha256, size: bytes.byteLength };
    if (!checked.has(remote.path)) {
      if (!await transport.exists(remote)) await transport.upload(remote, bytes);
      checked.add(remote.path);
    }
    return remote;
  });
}

/** No local writes until every PDF has downloaded and passed its hash check. */
export async function hydrateMaterialDownload(payload: SyncPayload, transport: MaterialTransport): Promise<SyncPayload> {
  selectCacheScope(transport.cacheScope);
  return mapFiles(payload, async file => {
    if (file.kind === 'quiz-material-file') return file; // Old backups/cloud snapshots remain readable.
    if (file.path.split('/')[0] !== transport.userId) throw new Error('資料の所有者が現在のアカウントと一致しません。');
    const key = `${file.bucket}:${file.path}:${file.sha256}:${file.size}`;
    let dataUrl = transport.cacheScope && cacheScope === transport.cacheScope ? verifiedPdfs.get(key) : undefined;
    if (!dataUrl) {
      const bytes = await transport.download(file);
      if (bytes.byteLength !== file.size || await digest(bytes) !== file.sha256) throw new Error('PDFの保存内容を確認できませんでした。端末データは変更していません。');
      dataUrl = encodePdf(bytes);
      if (transport.cacheScope && cacheScope === transport.cacheScope) cachePdf(key, dataUrl);
    }
    return { kind: 'quiz-material-file', version: 1, materialId: file.materialId, updatedAt: file.updatedAt, dataUrl };
  });
}

export function createMaterialTransport(config: { url: string; anonKey: string }, access: { userId: string; accessToken: string }): MaterialTransport {
  const headers = { apikey: config.anonKey, Authorization: `Bearer ${access.accessToken}` };
  const storageUrl = config.url.replace(/\/$/, '') + '/storage/v1';
  const objectUrl = (file: RemoteMaterialFile) => `${storageUrl}/object/${MATERIAL_BUCKET}/${file.path}`;
  const exists = async (file: RemoteMaterialFile) => {
    const response = await fetch(objectUrl(file), { method: 'HEAD', headers, signal: AbortSignal.timeout(30000) });
    if (response.ok) return true;
    if (response.status === 400 || response.status === 404) return false;
    throw new Error('PDFの保存先を確認できません。ログイン状態と通信を確認してください。');
  };
  return {
    userId: access.userId, cacheScope: `${config.url}:${access.userId}:${access.accessToken}`, exists,
    async upload(file, bytes) {
      const { Upload } = await import('tus-js-client');
      const endpoint = storageUrl.replace('.supabase.co/', '.storage.supabase.co/') + '/upload/resumable';
      await new Promise<void>((resolve, reject) => {
        const upload = new Upload(new Blob([bytes], { type: 'application/pdf' }), {
          endpoint, headers, chunkSize: 6 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000],
          uploadDataDuringCreation: true, removeFingerprintOnSuccess: true,
          fingerprint: async () => `${config.url}/${MATERIAL_BUCKET}/${file.path}`,
          metadata: { bucketName: MATERIAL_BUCKET, objectName: file.path, contentType: 'application/pdf', cacheControl: '3600' },
          onSuccess: () => { clearTimeout(timeout); resolve(); },
          onError: () => { clearTimeout(timeout); void exists(file).then(found => found ? resolve() : reject(new Error('PDFを同期できませんでした。通信とストレージの空き容量を確認し、再試行してください。')), reject); },
        });
        const timeout = setTimeout(() => { void upload.abort(); reject(new Error('PDFの送信が時間切れになりました。再試行すると続きから送信します。')); }, 5 * 60 * 1000);
        void upload.findPreviousUploads().then(previous => { if (previous[0]) upload.resumeFromPreviousUpload(previous[0]); upload.start(); }, () => upload.start());
      });
    },
    async download(file) {
      const response = await fetch(objectUrl(file), { headers, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('クラウドのPDFを取得できませんでした。端末データは変更していません。');
      // Enforce the advertised length while streaming, including chunked responses.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('PDFの受信を開始できませんでした。');
      const bytes = new Uint8Array(file.size); let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (offset + value.length > file.size) throw new Error('PDFのサイズが登録情報と一致しません。');
          bytes.set(value, offset); offset += value.length;
        }
      } finally { await reader.cancel(); }
      return bytes.subarray(0, offset);
    },
  };
}
