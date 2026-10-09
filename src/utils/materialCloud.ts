import { MATERIAL_BUCKET, materialFileEntry, type MaterialFile, type RemoteMaterialFile } from './materialModel';
import type { SyncPayload } from './syncService';
import { recordSyncMetric } from './syncMetrics';
import { SyncDataError, type SyncFailureDetails } from './syncDataIntegrity';

// Key by exact immutable content, never ID/timestamp. Bound retained base64 text.
const pdfDigests = new Map<string, Promise<{ sha256: string; size: number }>>();
const MAX_DIGEST_CHARACTERS = 48 * 1024 * 1024;
let digestCharacters = 0;
async function describePdf(dataUrl: string): Promise<{ sha256: string; size: number }> {
  const cached = pdfDigests.get(dataUrl);
  if (cached) { recordSyncMetric('pdfDigestReused'); return cached; }
  const pending = (async () => {
    const started = performance.now();
    const bytes = decodePdf(dataUrl);
    const sha256 = await digest(bytes);
    recordSyncMetric('pdfDigest', performance.now() - started, bytes.byteLength);
    return { sha256, size: bytes.byteLength };
  })();
  if (dataUrl.length <= MAX_DIGEST_CHARACTERS) {
    while (digestCharacters + dataUrl.length > MAX_DIGEST_CHARACTERS) {
      const oldest = pdfDigests.keys().next().value!;
      pdfDigests.delete(oldest);
      digestCharacters -= oldest.length;
    }
    pdfDigests.set(dataUrl, pending);
    digestCharacters += dataUrl.length;
    void pending.catch(() => {
      if (pdfDigests.get(dataUrl) === pending) { pdfDigests.delete(dataUrl); digestCharacters -= dataUrl.length; }
    });
  }
  return pending;
}

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
      const sha256 = file.kind === 'quiz-material-file' ? (await describePdf(file.dataUrl)).sha256 : file.sha256;
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
async function mapFiles(payload: SyncPayload, transform: (file: MaterialFile | RemoteMaterialFile,key:string) => Promise<MaterialFile | RemoteMaterialFile>,progress?:(completed:number,total:number)=>void) {
  let completed=0;const total=progress?fileEntries(payload).length:0;
  const report=()=>{try{progress?.(completed,total);}catch{/* Informational only. */}};report();
  const map = async (entries: Record<string, string>) => {
    const result = { ...entries };
    // Sequential processing bounds memory and avoids bursts of large uploads.
    for (const [key, raw] of Object.entries(entries)) {
      const file = materialFileEntry(key, raw);
      if (file) { result[key] = JSON.stringify(await transform(file,key));completed++;report(); }
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
    const { sha256, size } = await describePdf(file.dataUrl);
    const remote: RemoteMaterialFile = { kind: 'quiz-material-remote-file', version: 1, materialId: file.materialId,
      updatedAt: file.updatedAt, bucket: MATERIAL_BUCKET, path: `${transport.userId}/${sha256}.pdf`, sha256, size };
    if (!checked.has(remote.path)) {
      if (!await transport.exists(remote)) {
        await transport.upload(remote, decodePdf(file.dataUrl));
        recordSyncMetric('pdfUpload', 0, size);
      }
      checked.add(remote.path);
    }
    return remote;
  });
}

/** No local writes until every PDF has downloaded and passed its hash check. */
export async function hydrateMaterialDownload(payload: SyncPayload, transport: MaterialTransport, localPayload?: SyncPayload,progress?:(completed:number,total:number)=>void,options:{assertCurrent?:()=>Promise<void>;localFile?:(key:string)=>Promise<MaterialFile|RemoteMaterialFile|null>;diagnostic?:(value:SyncFailureDetails)=>void}={}): Promise<SyncPayload> {
  selectCacheScope(transport.cacheScope);
  const localFiles = new Map(fileEntries(localPayload ?? { version: 1, updatedAt: '', localStorage: {} })
    .filter((file): file is MaterialFile => file.kind === 'quiz-material-file').map(file => [file.materialId, file]));
  const counts={total:fileEntries(payload).length,completed:0,downloaded:0,cacheReused:0,localReused:0};
  const report=()=>{try{options.diagnostic?.({function:'hydrateMaterialDownload',stage:'pdf_download',...counts});}catch{}};
  try{return await mapFiles(payload, async (file,keyName) => {
    await options.assertCurrent?.();
    if (file.kind === 'quiz-material-file'){counts.completed++;report();return file;} // Old backups/cloud snapshots remain readable.
    if (file.path.split('/')[0] !== transport.userId) throw new SyncDataError('permission_denied','資料の所有者が現在のアカウントと一致しません。',{function:'hydrateMaterialDownload',stage:'pdf_download',cause:'reference'});
    const key = `${file.bucket}:${file.path}:${file.sha256}:${file.size}`;
    let dataUrl = transport.cacheScope && cacheScope === transport.cacheScope ? verifiedPdfs.get(key) : undefined;
    if(dataUrl)counts.cacheReused++;
    const candidate=!dataUrl?(localFiles.get(file.materialId)??await options.localFile?.(keyName)):undefined;
    const localFile=candidate?.kind==='quiz-material-file'?candidate:undefined;
    if (!dataUrl && localFile) {
      // Reuse durable local PDFs across app launches, but never trust the ID or
      // timestamp alone: verify the exact content against the cloud digest.
      try{const described = await describePdf(localFile.dataUrl);
      if (described.size === file.size && described.sha256 === file.sha256){dataUrl = localFile.dataUrl;counts.localReused++;}}catch{/* A bad local cache is not a verified cloud PDF. Keep it and fetch the source. */}
    }
    if (!dataUrl) {
      const bytes = await transport.download(file);
      if (bytes.byteLength !== file.size)throw new SyncDataError('pdf_integrity','PDFの内容を検証できませんでした。',{function:'hydrateMaterialDownload',stage:'pdf_integrity',cause:'size'});
      if(await digest(bytes)!==file.sha256)throw new SyncDataError('pdf_integrity','PDFの内容を検証できませんでした。',{function:'hydrateMaterialDownload',stage:'pdf_integrity',cause:'sha256'});
      counts.downloaded++;
      dataUrl = encodePdf(bytes);
    }
    if (transport.cacheScope && cacheScope === transport.cacheScope) cachePdf(key, dataUrl);
    await options.assertCurrent?.();counts.completed++;report();
    return { kind: 'quiz-material-file', version: 1, materialId: file.materialId, updatedAt: file.updatedAt, dataUrl };
  },progress);}catch(error){report();if(error instanceof SyncDataError){Object.assign(error.diagnostic,counts);throw error;}throw error;}
}

export function createMaterialTransport(config: { url: string; anonKey: string }, access: { userId: string; accessToken: string },options:{fetch?:typeof fetch;wait?:(ms:number)=>Promise<void>;downloadTimeoutMs?:number;assertCurrent?:()=>Promise<void>}={}): MaterialTransport {
  const downloadFetch=options.fetch??fetch,wait=options.wait??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
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
      if(file.path.split('/')[0]!==access.userId)throw new SyncDataError('permission_denied','資料の所有者が現在のアカウントと一致しません。',{function:'materialDownload',stage:'pdf_download',cause:'reference'});
      for(let attempt=0;;attempt++)try{
      await options.assertCurrent?.();
      const response = await downloadFetch(objectUrl(file), { headers, redirect:'error', signal: AbortSignal.timeout(options.downloadTimeoutMs??120000) });
      if (!response.ok){const status=response.status;await response.body?.cancel();throw new SyncDataError(status===401?'authentication_required':status===403?'permission_denied':status===404?'pdf_missing':'pdf_download',status===404?'クラウドのPDF本体が見つかりません。':'PDFの取得に失敗しました。再試行してください。',{function:'materialDownload',stage:'pdf_download',cause:'http',httpStatus:status,attempts:attempt+1},status===408||status===429||status>=500);}
      // Enforce the advertised length while streaming, including chunked responses.
      const reader = response.body?.getReader();
      if (!reader) throw new SyncDataError('pdf_download','PDFの受信を開始できませんでした。',{function:'materialDownload',stage:'pdf_download',cause:'network'},true);
      const bytes = new Uint8Array(file.size); let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (offset + value.length > file.size) throw new SyncDataError('pdf_integrity','PDFの内容を検証できませんでした。',{function:'materialDownload',stage:'pdf_integrity',cause:'size'});
          bytes.set(value, offset); offset += value.length;
        }
      } finally { await reader.cancel().catch(()=>{}); }
      if(offset!==file.size)throw new SyncDataError('pdf_integrity','PDFの内容を検証できませんでした。',{function:'materialDownload',stage:'pdf_integrity',cause:'size'});
      await options.assertCurrent?.();
      return bytes.subarray(0, offset);
      }catch(reason){
        if(reason instanceof Error&&reason.name==='SyncInterruptedError')throw reason;
        if(reason&&typeof reason==='object'&&'code' in reason&&['authentication_required','permission_denied','local_persistence_failed','connection_changed','local_changed','mode_changed'].includes(String(reason.code))&&!(reason instanceof SyncDataError))throw reason;
        const error=reason instanceof SyncDataError?reason:reason instanceof RangeError?new SyncDataError('memory_limit','同期データを処理するメモリが不足しています。',{function:'materialDownload',stage:'pdf_download',cause:'memory'}):new SyncDataError('pdf_download','PDFの取得に失敗しました。再試行してください。',{function:'materialDownload',stage:'pdf_download',cause:reason instanceof Error&&['AbortError','TimeoutError'].includes(reason.name)?'timeout':'network'},true);
        error.diagnostic.attempts=attempt+1;if(!error.retryable||attempt>=2)throw error;await wait([500,1500][attempt]);
      }
    },
  };
}
