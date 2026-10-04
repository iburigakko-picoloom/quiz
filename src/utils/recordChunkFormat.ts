import { SyncProtocolError } from './syncInterruption';

export const RECORD_CHUNK_BYTES = 200 * 1024;
export const RECORD_CHUNK_PREFIX = 'quizMake:recordChunks:v1:';
// Released plan-aware clients reject this before applying any records, including notes.
export const RECORD_CHUNK_GUARD_ID = 'quizMake:plan:__record_chunks_v1';
export const RECORD_CHUNK_GUARD_RAW = '{"kind":"quiz-record-chunks-required","schema":1}';
const HASH = /^[a-f0-9]{64}$/u;
const MANIFEST_KIND = 'quiz-record-chunk-manifest';
const CHUNK_KIND = 'quiz-record-chunk';
export type ChunkManifest = {
  kind: typeof MANIFEST_KIND; schema: 1; collection: 'localStorage' | 'indexedDbNotes';
  id: string; parentHash: string; version: string; totalBytes: number; count: number; hashes: string[];
};
type Chunk = { kind: typeof CHUNK_KIND; schema: 1; parentHash: string; version: string; index: number; bytes: number; hash: string; data: string };
export const chunkFailure = () => new SyncProtocolError('invalid_response', '分割された同期データが揃っていないか、内容を検証できません。既存データは保持しています。');
export const isChunkInternal = (collection: string, id: string) => collection === 'localStorage'
  && (id === RECORD_CHUNK_GUARD_ID || id.startsWith(RECORD_CHUNK_PREFIX));
export const chunkId = (m: ChunkManifest, index: number) => RECORD_CHUNK_PREFIX + m.parentHash + ':' + m.version + ':' + index;
export const chunkIds = (m: ChunkManifest) => Array.from({ length: m.count }, (_, index) => chunkId(m, index));
export function parseChunkManifest(raw: string | null, collection: string, id: string): ChunkManifest | null {
  if (!raw?.includes(MANIFEST_KIND)) return null;
  let value: ChunkManifest;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value?.kind !== MANIFEST_KIND) return null;
  if (value.schema !== 1 || !['localStorage','indexedDbNotes'].includes(collection) || value.collection !== collection || value.id !== id
    || isChunkInternal(collection,id) || !HASH.test(value.parentHash) || !HASH.test(value.version)
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || !Number.isSafeInteger(value.count)
    || value.count !== Math.ceil(value.totalBytes / RECORD_CHUNK_BYTES) || value.count > 4096
    || !Array.isArray(value.hashes) || value.hashes.length !== value.count || !value.hashes.every(hash => typeof hash === 'string' && HASH.test(hash))) throw chunkFailure();
  return value;
}
function parseChunk(id: string, raw: string): Chunk {
  let v: Chunk;
  try { v = JSON.parse(raw); } catch { throw chunkFailure(); }
  if (!v || v.kind !== CHUNK_KIND || v.schema !== 1 || !HASH.test(v.parentHash) || !HASH.test(v.version)
    || !Number.isSafeInteger(v.index) || v.index < 0 || v.index >= 4096 || !Number.isSafeInteger(v.bytes)
    || v.bytes < 1 || v.bytes > RECORD_CHUNK_BYTES || !HASH.test(v.hash) || typeof v.data !== 'string'
    || v.data.length !== 4 * Math.ceil(v.bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(v.data)
    || id !== RECORD_CHUNK_PREFIX + v.parentHash + ':' + v.version + ':' + v.index) throw chunkFailure();
  return v;
}
export function validateChunkWire(collection: string, id: string, raw: string | null): boolean {
  if (isChunkInternal(collection,id)) {
    if (raw !== null) id === RECORD_CHUNK_GUARD_ID
      ? (() => { if (raw !== RECORD_CHUNK_GUARD_RAW) throw chunkFailure(); })() : parseChunk(id,raw);
    return true;
  }
  return Boolean(parseChunkManifest(raw,collection,id));
}
export async function hashChunkBytes(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map(byte => byte.toString(16).padStart(2,'0')).join('');
}
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i=0;i<bytes.length;i+=8192) text += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
export async function encodeRecordChunks(collection: ChunkManifest['collection'], id: string, raw: string) {
  const bytes = new TextEncoder().encode(raw), version = await hashChunkBytes(bytes);
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== raw) throw chunkFailure();
  const parentHash = await hashChunkBytes(JSON.stringify([collection,id]));
  const count = Math.ceil(bytes.length / RECORD_CHUNK_BYTES);
  if (!count || count > 4096 || isChunkInternal(collection,id)) throw chunkFailure();
  const manifest: ChunkManifest = { kind: MANIFEST_KIND, schema: 1, collection, id, parentHash, version, totalBytes: bytes.length, count, hashes: [] };
  const parts: Array<{ id: string; raw: string }> = [];
  for (let index=0;index<count;index++) {
    const part = bytes.subarray(index*RECORD_CHUNK_BYTES,(index+1)*RECORD_CHUNK_BYTES), hash = await hashChunkBytes(part);
    manifest.hashes.push(hash);
    parts.push({ id: chunkId(manifest,index), raw: JSON.stringify({ kind: CHUNK_KIND, schema: 1, parentHash, version, index, bytes: part.length, hash, data: base64(part) } satisfies Chunk) });
  }
  return { manifest, raw: JSON.stringify(manifest), parts };
}
export async function restoreRecordChunks(manifest: ChunkManifest, values: Map<string,string>): Promise<string> {
  if (await hashChunkBytes(JSON.stringify([manifest.collection,manifest.id])) !== manifest.parentHash) throw chunkFailure();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let index=0;index<manifest.count;index++) {
    const id = chunkId(manifest,index), raw = values.get(id);
    if (!raw) throw chunkFailure();
    const part = parseChunk(id,raw);
    if (part.hash !== manifest.hashes[index] || part.bytes !== Math.min(RECORD_CHUNK_BYTES,manifest.totalBytes-index*RECORD_CHUNK_BYTES)) throw chunkFailure();
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(part.data), c => c.charCodeAt(0)); } catch { throw chunkFailure(); }
    if (bytes.length !== part.bytes || await hashChunkBytes(bytes) !== part.hash) throw chunkFailure();
    parts.push(bytes); size += bytes.length;
  }
  if (size !== manifest.totalBytes) throw chunkFailure();
  const all = new Uint8Array(size);
  let offset=0; for (const part of parts) { all.set(part,offset); offset+=part.length; }
  if (await hashChunkBytes(all) !== manifest.version) throw chunkFailure();
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(all); } catch { throw chunkFailure(); }
}
/** Decode transport-only records before normal backup/Snapshot validation. Never mutate input. */
export async function hydrateChunkPayload<T>(value: T): Promise<T> {
  const input = value as T & { localStorage?: Record<string,string>; indexedDbNotes?: Record<string,string> };
  if (!input || typeof input !== 'object' || !input.localStorage || typeof input.localStorage !== 'object') return value;
  const localStorage = { ...input.localStorage }, indexedDbNotes = { ...input.indexedDbNotes };
  const parts = new Map<string,string>();
  for (const [id,raw] of Object.entries(localStorage)) if (isChunkInternal('localStorage',id)) {
    validateChunkWire('localStorage',id,raw); if (id !== RECORD_CHUNK_GUARD_ID) parts.set(id,raw);
    delete localStorage[id];
  }
  let changed = parts.size > 0 || RECORD_CHUNK_GUARD_ID in input.localStorage;
  for (const [collection,values] of [['localStorage',localStorage],['indexedDbNotes',indexedDbNotes]] as const) {
    for (const [id,raw] of Object.entries(values)) {
      if (typeof raw !== 'string') continue;
      const manifest = parseChunkManifest(raw,collection,id);
      if (!manifest) continue;
      if (input.localStorage[RECORD_CHUNK_GUARD_ID] !== RECORD_CHUNK_GUARD_RAW) throw chunkFailure();
      values[id] = await restoreRecordChunks(manifest,parts); changed=true;
    }
  }
  return changed ? { ...input, localStorage, indexedDbNotes } : value;
}
