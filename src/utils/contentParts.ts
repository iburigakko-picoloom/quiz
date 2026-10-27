/** Keep each cloud object within the existing storage bucket limit. */
export const MAX_CONTENT_OBJECT_BYTES = 50 * 1024 * 1024;
export const CONTENT_PART_BYTES = 32 * 1024 * 1024;
export interface ContentPart { sha256: string; size: number }
export interface ContentReference extends ContentPart { parts?: ContentPart[] }

export async function contentHash(blob: Blob): Promise<string> {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function describeContent(blob: Blob): Promise<ContentReference> {
  const ref: ContentReference = { sha256: await contentHash(blob), size: blob.size };
  if (blob.size > MAX_CONTENT_OBJECT_BYTES) {
    ref.parts = [];
    for (let offset = 0; offset < blob.size; offset += CONTENT_PART_BYTES) {
      const part = blob.slice(offset, offset + CONTENT_PART_BYTES);
      ref.parts.push({ sha256: await contentHash(part), size: part.size });
    }
  }
  return ref;
}
export function validContentParts(ref: ContentReference): boolean {
  // Older local recovery blobs can exceed the cloud object limit. They remain
  // readable even though newly uploaded large files always carry parts.
  if (ref.parts === undefined) return true;
  return Array.isArray(ref.parts) && ref.parts.length >= 2 && ref.parts.length <= 64
    && ref.parts.every(part => !!part && /^[a-f0-9]{64}$/.test(part.sha256)
      && Number.isSafeInteger(part.size) && part.size > 0 && part.size <= MAX_CONTENT_OBJECT_BYTES)
    && ref.parts.reduce((sum, part) => sum + part.size, 0) === ref.size;
}

export async function uploadContentParts(ref: ContentReference, blob: Blob, send: (part: ContentPart, bytes: Blob) => Promise<void>): Promise<void> {
  if (!validContentParts(ref) || blob.size !== ref.size || (!ref.parts && ref.size > MAX_CONTENT_OBJECT_BYTES)) throw new Error('本文の分割情報が不正です。');
  let offset = 0;
  for (const part of ref.parts ?? [ref]) {
    const bytes = blob.slice(offset, offset + part.size, blob.type); offset += part.size;
    if (await contentHash(bytes) !== part.sha256) throw new Error('本文のハッシュが一致しません。');
    await send(part, bytes);
  }
}
export async function downloadContentParts(ref: ContentReference, type: string, receive: (part: ContentPart) => Promise<Blob>): Promise<Blob> {
  if (!validContentParts(ref)) throw new Error('本文の分割情報が不正です。');
  const parts: Blob[] = [];
  for (const part of ref.parts ?? [ref]) {
    const blob = await receive(part);
    if (blob.size !== part.size || await contentHash(blob) !== part.sha256) throw new Error('本文のハッシュが一致しません。');
    parts.push(blob);
  }
  const blob = new Blob(parts, { type });
  if (ref.parts && await contentHash(blob) !== ref.sha256) throw new Error('本文のハッシュが一致しません。');
  return blob;
}
