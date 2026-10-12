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
