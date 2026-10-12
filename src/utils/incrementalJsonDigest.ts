import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Sync payloads contain plain JSON values. Stream strings too: one note can be
// much larger than a transport part. Preserve JSON.stringify's escaping and
// UTF-16 surrogate handling at chunk boundaries.
export function* jsonFragments(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16384, value.length);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i) yield ',';
      yield* jsonFragments(value[i] ?? null);
    }
    yield ']';
  } else if (value && typeof value === 'object') {
    yield '{';
    let first = true;
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (!first) yield ',';
      first = false;
      yield* jsonFragments(key);
      yield ':';
      yield* jsonFragments(item);
    }
    yield '}';
  } else {
    yield JSON.stringify(value) ?? 'null';
  }
}

export async function hashJsonFragments(fragments: Iterable<string>): Promise<string> {
  const hash = sha256.create(), encoder = new TextEncoder();
  let deadline = performance.now() + 8;
  for (const fragment of fragments) {
    hash.update(encoder.encode(fragment));
    if (performance.now() >= deadline) {
      // A macrotask permits painting/input; Promise.resolve would not.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      deadline = performance.now() + 8;
    }
  }
  return bytesToHex(hash.digest());
}

export const incrementalJsonDigest = (value: unknown): Promise<string> => hashJsonFragments(jsonFragments(value));

/** Measure serialized UTF-8 without constructing another full backup. */
export async function jsonByteSize(value:unknown):Promise<number>{
  const encoder=new TextEncoder();let size=0,deadline=performance.now()+8;
  for(const fragment of jsonFragments(value)){
    size+=encoder.encode(fragment).length;
    if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+8;}
  }
  return size;
}

/** A backup can exceed the JS heap even though its individual notes fit. Keep
 * the serialized copy in Blob storage, never a second full escaped JS string. */
export async function jsonBackupBlob(value: unknown): Promise<{blob:Blob;digest:string}> {
  const hash=sha256.create(),encoder=new TextEncoder(),parts:Blob[]=[];
  let pending:Uint8Array<ArrayBuffer>[]=[],size=0,deadline=performance.now()+8;
  for(const fragment of jsonFragments(value)){
    const bytes=encoder.encode(fragment);hash.update(bytes);pending.push(bytes);size+=bytes.length;
    if(size>=256*1024){parts.push(new Blob(pending));pending=[];size=0;}
    if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+8;}
  }
  if(pending.length)parts.push(new Blob(pending));
  return {blob:new Blob(parts,{type:'application/json'}),digest:bytesToHex(hash.digest())};
}

export async function hashBackupBlob(blob:Blob):Promise<string>{
  const hash=sha256.create();
  for(let offset=0;offset<blob.size;offset+=256*1024){
    hash.update(new Uint8Array(await blob.slice(offset,offset+256*1024).arrayBuffer()));
  }
  return bytesToHex(hash.digest());
}
