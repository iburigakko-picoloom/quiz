// Only newly created union generations use this reversible representation.
// Repeated JSON string tokens (frozen question explanations in plans) are stored
// once. The application, backups and record protocol still see exact raw text.
export const ACCOUNT_VALUE_PREFIX = 'quiz-make-union-value-v1:';
const MAX_TEXT = 64 * 1024 * 1024;
function checksum(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
export function encodeAccountValue(value: string): string {
  if (value.length < 4096 && !value.startsWith(ACCOUNT_VALUE_PREFIX) || value.length > MAX_TEXT) return value;
  const counts = new Map<string, number>();
  for (const match of value.matchAll(/"(?:[^"\\]|\\.)*"/gu)) if (match[0].length >= 256) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  const strings = [...counts].filter(([, count]) => count > 1).map(([text]) => text), indices = new Map(strings.map((text, i) => [text, i]));
  const parts: Array<string | number> = []; let cursor = 0;
  for (const match of value.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
    const index = indices.get(match[0]); if (index === undefined) continue;
    if (match.index! > cursor) parts.push(value.slice(cursor, match.index)); parts.push(index); cursor = match.index! + match[0].length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  const encoded = ACCOUNT_VALUE_PREFIX + JSON.stringify({ version: 1, length: value.length, checksum: checksum(value), strings, parts });
  return value.startsWith(ACCOUNT_VALUE_PREFIX) || encoded.length < value.length * 0.9 ? encoded : value;
}
export function decodeAccountValue(stored: string): string {
  if (!stored.startsWith(ACCOUNT_VALUE_PREFIX)) return stored;
  const fail = () => { throw new Error('統合後の保存設定を読み取れません。原本の控えは保持しています。'); };
  let row; try { row = JSON.parse(stored.slice(ACCOUNT_VALUE_PREFIX.length)); } catch { return fail(); }
  if (row?.version !== 1 || !Number.isSafeInteger(row.length) || row.length < 0 || row.length > MAX_TEXT || !Array.isArray(row.strings) || !row.strings.every((v: unknown) => typeof v === 'string') || !Array.isArray(row.parts)) return fail();
  let length = 0; const parts: string[] = [];
  for (const part of row.parts) {
    const text = typeof part === 'string' ? part : Number.isSafeInteger(part) && part >= 0 ? row.strings[part] : undefined;
    if (typeof text !== 'string' || (length += text.length) > row.length) return fail(); parts.push(text);
  }
  const value = parts.join(''); if (length !== row.length || checksum(value) !== row.checksum) return fail(); return value;
}
