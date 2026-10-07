import { SyncLocalPersistenceError } from './syncInterruption';
export type SyncDevice = { version: 1; id: string; name: string };
// A tiny browser installation setting: never included in learning data or an
// account's backup, so restoring another device cannot copy its identity.
export const SYNC_DEVICE_KEY = 'quizMakeDevice:v1';
const valid = (value: unknown): value is SyncDevice => {
  if (!value || typeof value !== 'object') return false;
  const device = value as SyncDevice;
  return device.version === 1 && typeof device.id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(device.id)
    && typeof device.name === 'string' && Boolean(device.name.trim())
    && new TextEncoder().encode(JSON.stringify(device)).length <= 160;
};
export function getSyncDevice(storage: Pick<Storage, 'getItem' | 'setItem'> = globalThis.localStorage, userAgent = navigator.userAgent): string {
  try {
  const stored = storage.getItem(SYNC_DEVICE_KEY);
  if (stored !== null) {
    if (!valid(JSON.parse(stored))) throw new Error('端末情報を確認できません。未送信の変更は保持しています。');
    return stored;
  }
  const name = /Android/i.test(userAgent) ? 'Android' : /iPhone|iPad/i.test(userAgent) ? 'iPhone / iPad'
    : /Windows/i.test(userAgent) ? 'Windows' : /Macintosh/i.test(userAgent) ? 'Mac' : 'ブラウザ';
  const raw = JSON.stringify({ version: 1, id: crypto.randomUUID(), name } satisfies SyncDevice);
  storage.setItem(SYNC_DEVICE_KEY, raw);
  if (storage.getItem(SYNC_DEVICE_KEY) !== raw) throw new Error('端末情報を保存できません。未送信の変更は保持しています。');
  return raw;
  } catch {
    throw new SyncLocalPersistenceError('端末情報を保存・確認できません。未送信の変更は保持しています。');
  }
}
export function readSyncDevice(raw?: string | null): { name: string; id?: string } {
  try { const value: unknown = JSON.parse(raw ?? ''); if (valid(value)) return value; } catch { /* Older clients recorded only a display name. */ }
  return { name: raw || '不明' };
}
