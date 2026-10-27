/** Account-scoped, content addressed storage. Bodies are verified before a
 * reference is returned; failed writes leave the source and migration cursor intact. */
import { contentHash, describeContent, validContentParts, type ContentReference } from './contentParts';
export const BLOB_STORES = ['contentBlobs', 'contentBlobMeta', 'contentBlobRefs', 'contentBlobJobs'] as const;
export type BlobRef = ContentReference & { type: string };
export type BlobMeta = BlobRef & { touched: number; uploaded?: boolean; origin: 'local' | 'remote'; offline?: boolean };
export const BLOB_NOTE_KIND = 'quiz-note-blobs';
type BlobNote = { kind: typeof BLOB_NOTE_KIND; version: 1; value: unknown; blobs: BlobRef[]; template?: string; templateRef?: BlobRef; prefix?: string };
const marker = 'quiz-blob:';
export const idbResult = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
export const idbDone = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('保存を完了できませんでした。元データを保持しています。'));
});
export async function readMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const tx = db.transaction('appRecordMeta', 'readonly'), done = idbDone(tx);
  const value = await idbResult<T | undefined>(tx.objectStore('appRecordMeta').get(key)); await done; return value;
}
export async function writeMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction('appRecordMeta', 'readwrite'), done = idbDone(tx);
  if (value === undefined) tx.objectStore('appRecordMeta').delete(key); else tx.objectStore('appRecordMeta').put(value, key);
  await done;
}
export const blobHash = contentHash;
export async function putContentBlob(db: IDBDatabase, blob: Blob, options: { origin?: 'local' | 'remote'; expected?: BlobRef } = {}): Promise<BlobRef> {
  const ref: BlobRef = { ...await describeContent(blob), type: blob.type || 'application/octet-stream' };
  if (options.expected && (options.expected.sha256 !== ref.sha256 || options.expected.size !== ref.size)) throw new Error('本文のハッシュが一致しません。元データを保持しています。');
  // Binary buffers also work on WebKit builds whose IndexedDB Blob serializer
  // cannot persist file-backed Blob parts. Hydration exposes the same Blob API.
  const exists=await readBlobMeta(db,ref.sha256);
  const bytes=exists?undefined:new Uint8Array(await blob.arrayBuffer());
  const tx = db.transaction(['contentBlobs', 'contentBlobMeta', 'appRecordMeta'], 'readwrite'), done = idbDone(tx);
  const current = tx.objectStore('contentBlobMeta').get(ref.sha256);
  current.onsuccess = () => {
    const previous = current.result as BlobMeta | undefined;
    if (!previous) {
      if(!bytes){tx.abort();return;}
      tx.objectStore('contentBlobs').put(bytes, ref.sha256);
      const usage = tx.objectStore('appRecordMeta').get('blobUsage');
      usage.onsuccess = () => tx.objectStore('appRecordMeta').put({ bytes: (usage.result?.bytes ?? 0) + ref.size, count: (usage.result?.count ?? 0) + 1 }, 'blobUsage');
    }
    tx.objectStore('contentBlobMeta').put({ ...ref, ...previous, touched: Date.now(), origin: previous?.origin === 'local' || options.origin !== 'remote' ? 'local' : 'remote' }, ref.sha256);
  };
  await done;
  // Read-back verification precedes every legacy reference switch.
  const check = await getContentBlob(db, ref);
  if (!check || await blobHash(check) !== ref.sha256) throw new Error('本文の保存を検証できません。移行前の原本を保持しています。');
  return ref;
}
async function readBlobMeta(db:IDBDatabase,hash:string):Promise<BlobMeta|undefined>{
  const tx=db.transaction('contentBlobMeta'),done=idbDone(tx),value=await idbResult<BlobMeta|undefined>(tx.objectStore('contentBlobMeta').get(hash));await done;return value;
}
export async function getContentBlob(db: IDBDatabase, ref: BlobRef): Promise<Blob | undefined> {
  const tx = db.transaction(['contentBlobs', 'contentBlobMeta'], 'readwrite'), done = idbDone(tx);
  const content = tx.objectStore('contentBlobs').get(ref.sha256), meta = tx.objectStore('contentBlobMeta').get(ref.sha256);
  meta.onsuccess = () => { if (content.result && meta.result) tx.objectStore('contentBlobMeta').put({ ...meta.result, touched: Date.now() }, ref.sha256); };
  await done; const value=content.result as Blob|Uint8Array<ArrayBuffer>|ArrayBuffer|undefined;
  const blob=value instanceof Blob?value:value?new Blob([value],{type:ref.type}):undefined;
  if (blob && blob.size !== ref.size) throw new Error('保存した本文のサイズが一致しません。');
  return blob;
}
export function parseBlobNote(raw: string | null): BlobNote | null {
  if (!raw?.includes('"' + BLOB_NOTE_KIND + '"')) return null;
  let v: BlobNote;
  try { v = JSON.parse(raw); } catch { return null; }
  if (v.kind !== BLOB_NOTE_KIND || v.version !== 1 || !Array.isArray(v.blobs) || !v.value || typeof v.value !== 'object'
    || v.blobs.some(ref => !ref || !/^[0-9a-f]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 1 || typeof ref.type !== 'string' || !validContentParts(ref))) return null;
  return v;
}
function decodeDataUrl(url: string): Blob {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) throw new Error('本文の形式を確認できません。');
  const binary = atob(match[2]), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}
export async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer()), parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return `data:${blob.type};base64,${btoa(parts.join(''))}`;
}
export async function packBlobNote(db: IDBDatabase, raw: string, origin: 'local' | 'remote' = 'local'): Promise<string> {
  if (parseBlobNote(raw) || (!raw.includes('data:') && raw.length < 16384)) return raw;
  const refs = new Map<string, BlobRef>();
  // Keep exact JSON whitespace/key order, including JSON strings nested inside
  // legacy backup files. Complete export must reproduce the original digest.
  let prefix = marker + await blobHash(new Blob([raw])) + ':';
  while (raw.includes(prefix)) prefix += ':';
  const chunks: string[] = []; let offset = 0;
  const pattern = /data:(?:application\/pdf|image\/[\w.+-]+);base64,[A-Za-z0-9+/]+={0,2}/g;
  for (const match of raw.matchAll(pattern)) {
    const ref = await putContentBlob(db, decodeDataUrl(match[0]), { origin }); refs.set(ref.sha256 + ':' + ref.type, ref);
    chunks.push(raw.slice(offset, match.index), prefix + ref.sha256 + ':' + encodeURIComponent(ref.type) + ':'); offset = match.index! + match[0].length;
  }
  chunks.push(raw.slice(offset)); const template = chunks.join('');
  if (template.length >= 16384) {
    const templateRef = await putContentBlob(db,new Blob([template],{type:'application/json'}),{origin});
    refs.set(templateRef.sha256+':'+templateRef.type,templateRef);
    const value=JSON.parse(template);
    return JSON.stringify({kind:BLOB_NOTE_KIND,version:1,value:{kind:value.kind,version:value.version,updatedAt:value.updatedAt},templateRef,prefix,blobs:[...refs.values()]} satisfies BlobNote);
  }
  if (!refs.size) return raw;
  return JSON.stringify({ kind: BLOB_NOTE_KIND, version: 1, value: JSON.parse(template), template, prefix, blobs: [...refs.values()] } satisfies BlobNote);
}
export async function unpackBlobNote(db: IDBDatabase, raw: string, fetchMissing?: (ref: BlobRef) => Promise<Blob>): Promise<string> {
  const note = parseBlobNote(raw); if (!note) return raw;
  if (note.templateRef) {
    if (!note.blobs.some(ref=>ref.sha256===note.templateRef!.sha256&&ref.size===note.templateRef!.size)) throw new Error('本文の参照一覧が一致しません。');
    let blob=await getContentBlob(db,note.templateRef);
    if(!blob&&fetchMissing){blob=await fetchMissing(note.templateRef);await putContentBlob(db,blob,{origin:'remote',expected:note.templateRef});}
    if(!blob)throw new Error('本文の転送がまだ完了していません。保存元の端末で同期してください。');
    note.template=await blob.text();
  }
  if (note.template !== undefined) {
    if (typeof note.template !== 'string' || typeof note.prefix !== 'string' || !note.prefix.startsWith(marker)) throw new Error('本文の参照形式が不正です。');
    let restored = note.template;
    for (const ref of note.blobs) {
      if(note.templateRef?.sha256===ref.sha256)continue;
      let blob = await getContentBlob(db, ref);
      if (!blob && fetchMissing) { blob = await fetchMissing(ref); await putContentBlob(db, blob, { origin: 'remote', expected: ref }); }
      if (!blob) throw new Error('資料の転送がまだ完了していません。保存元の端末の同期後にもう一度開いてください。');
      restored = restored.split(note.prefix + ref.sha256 + ':' + encodeURIComponent(ref.type) + ':').join(await blobDataUrl(new Blob([blob], { type: ref.type })));
    }
    return restored;
  }
  const refs = new Map(note.blobs.map(ref => [ref.sha256, ref]));
  const resolved = new Map<string, string>();
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string' && v.startsWith(marker)) {
      const hash = v.slice(marker.length), ref = refs.get(hash); if (!ref) throw new Error('本文の参照が不正です。');
      if (resolved.has(hash)) return resolved.get(hash);
      let blob = await getContentBlob(db, ref);
      if (!blob && fetchMissing) { blob = await fetchMissing(ref); await putContentBlob(db, blob, { origin: 'remote', expected: ref }); }
      if (!blob) throw new Error('資料の転送がまだ完了していません。保存元の端末の同期後にもう一度開いてください。');
      const url = await blobDataUrl(new Blob([blob], { type: ref.type })); resolved.set(hash, url); return url;
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v && typeof v === 'object') { const result: Record<string, unknown> = {}; for (const [key, value] of Object.entries(v)) result[key] = await walk(value); return result; }
    return v;
  };
  return JSON.stringify(await walk(note.value));
}
/** Must be called in the transaction publishing the reference. */
export function queueBlobReferences(tx: IDBTransaction, owner: string, raw: string | null, protect = true): void {
  if (!tx.objectStoreNames.contains('contentBlobRefs')) return;
  let hashes = parseBlobNote(raw)?.blobs.map(ref => ref.sha256) ?? [];
  if (!hashes.length && raw) try { const v = JSON.parse(raw); if (v.vault && /^[0-9a-f]{64}$/.test(v.sha256)) hashes = [v.sha256]; } catch { /* Non-media record. */ }
  tx.objectStore('contentBlobRefs').put({ hashes, protect }, owner);
}
export function queueRecordHistory<T extends { raw: string | null }>(tx: IDBTransaction, key: string, old: T | undefined, raw: string | null): void {
  if (!old || old.raw === raw || !tx.objectStoreNames.contains('recordHistory')) return;
  queueBlobReferences(tx,`record-history:${key}`,old.raw);
  const request = tx.objectStore('recordHistory').get(key);
  request.onsuccess = () => {
    const versions = [old, ...(request.result ?? []).filter((row: { raw: string | null }) => row.raw !== old.raw && row.raw !== raw)].slice(0, 2);
    tx.objectStore('recordHistory').put(versions, key);
    for (let i = 0; i < 2; i++) queueBlobReferences(tx, `history:${key}:${i}`, versions[i]?.raw ?? null);
  };
}
export function queueBlobUploads(tx: IDBTransaction, raw: string): void {
  for (const ref of parseBlobNote(raw)?.blobs ?? []) {
    queueContentUpload(tx, ref);
  }
}
export function queueContentUpload(tx: IDBTransaction, ref: BlobRef): void {
    const meta = tx.objectStore('contentBlobMeta').get(ref.sha256);
    meta.onsuccess = () => { if (!meta.result?.uploaded) {
      tx.objectStore('contentBlobJobs').put(ref, ref.sha256);
      tx.objectStore('contentBlobRefs').put({ hashes: [ref.sha256], protect: true }, `upload:${ref.sha256}`);
    } };
}
export async function setBlobOffline(db: IDBDatabase, refs: BlobRef[], offline: boolean): Promise<void> {
  const tx = db.transaction('contentBlobMeta', 'readwrite'), done = idbDone(tx);
  for (const ref of refs) { const r = tx.objectStore('contentBlobMeta').get(ref.sha256); r.onsuccess = () => { if (r.result) tx.objectStore('contentBlobMeta').put({ ...r.result, offline }, ref.sha256); }; }
  await done;
}
/** Only remote, unpinned, unreferenced temporary content is eligible. */
export async function trimBlobCache(db: IDBDatabase, budget = 256 * 1024 * 1024): Promise<number> {
  const tx = db.transaction(['contentBlobs', 'contentBlobMeta', 'contentBlobRefs', 'appRecordMeta'], 'readwrite'), done = idbDone(tx);
  const refs = tx.objectStore('contentBlobRefs').getAll(), all = tx.objectStore('contentBlobMeta').getAll(), usage = tx.objectStore('appRecordMeta').get('blobUsage');
  let removed = 0;
  usage.onsuccess = () => {
    const protectedHashes = new Set<string>(refs.result.filter(r => r.protect).flatMap(r => r.hashes));
    const candidates = (all.result as BlobMeta[]).filter(r => r.origin === 'remote' && !r.offline && !protectedHashes.has(r.sha256)).sort((a, b) => a.touched - b.touched);
    let bytes = candidates.reduce((sum, r) => sum + r.size, 0), count = 0;
    for (const row of candidates) { if (bytes <= budget) break; tx.objectStore('contentBlobs').delete(row.sha256); tx.objectStore('contentBlobMeta').delete(row.sha256); bytes -= row.size; removed += row.size; count++; }
    // Own PDFs remain offline. Obsolete handwriting/manifest bodies can be
    // collected once every current/history/pending/rescue reference is gone.
    // A grace period protects verified bodies awaiting a reference transaction.
    const referenced=new Set<string>(refs.result.flatMap(r=>r.hashes));
    for(const row of all.result as BlobMeta[])if(row.origin==='local'&&row.type!=='application/pdf'&&!row.offline&&!referenced.has(row.sha256)&&row.touched<Date.now()-30*60*1000){
      tx.objectStore('contentBlobs').delete(row.sha256);tx.objectStore('contentBlobMeta').delete(row.sha256);removed+=row.size;count++;
    }
    if (removed) tx.objectStore('appRecordMeta').put({ bytes: Math.max(0, (usage.result?.bytes ?? 0) - removed), count: Math.max(0, (usage.result?.count ?? 0) - count) }, 'blobUsage');
  };
  await done; return removed;
}
