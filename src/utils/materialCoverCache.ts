import { accountDatabaseName, accountLocalStorage, getAccountStorageSession } from './accountStorage';
import { openAppDb } from '../storage';
import { appRecordKey } from './appRecordStorage';
import { materialFileKey } from './materialStorage';
import { loadCategoryNoteRaw } from './noteStorage';
import type { MaterialPage } from './materialModel';
import type { MaterialPagePreview } from './materialPreview';

const MAX_ENTRIES = 80;
const MAX_URL_LENGTH = 200_000;
const memory = new Map<string, MaterialPagePreview>();
const MAX_MEMORY = 24;
const quickMemory = new Map<string, MaterialPagePreview>();
const MAX_QUICK_BYTES = 8 * 1024 * 1024;
type Entry = { key: string; url: string; aspect: number; pixelWidth?: number; used: number };

export function materialCoverVersion(setId: string, materialId: string, page: MaterialPage): string | null {
  try {
    return JSON.stringify([accountDatabaseName('quiz-make-material-cover-v1'), setId, materialId, page.id, page.kind, page.pdfPage, accountLocalStorage.getItem('quizMake:coord:noteEpoch')]);
  } catch { return null; }
}
export function peekMaterialCover(setId: string, materialId: string, page: MaterialPage): MaterialPagePreview | null {
  const key = materialCoverVersion(setId, materialId, page), preview = key ? quickMemory.get(key) : undefined;
  if (!key || !preview) return null;
  quickMemory.delete(key); quickMemory.set(key, preview); return preview;
}
export function rememberMaterialCover(setId: string, materialId: string, page: MaterialPage, preview: MaterialPagePreview): void {
  const key = materialCoverVersion(setId, materialId, page);
  const size = (preview.url?.length ?? 0) + (preview.inkUrl?.length ?? 0);
  if (!key || size * 2 > MAX_QUICK_BYTES) return;
  quickMemory.delete(key); quickMemory.set(key, preview);
  let total = 0;
  for (const value of quickMemory.values()) total += ((value.url?.length ?? 0) + (value.inkUrl?.length ?? 0)) * 2;
  while (quickMemory.size > MAX_MEMORY || total > MAX_QUICK_BYTES) {
    const first = quickMemory.keys().next().value!;
    const removed = quickMemory.get(first)!;
    total -= ((removed.url?.length ?? 0) + (removed.inkUrl?.length ?? 0)) * 2;
    quickMemory.delete(first);
  }
}

/** A small JPEG avoids retaining full-size scanned PNGs in the thumbnail cache. */
export async function compactMaterialCover(preview: MaterialPagePreview): Promise<MaterialPagePreview> {
  if (!preview.url) return preview;
  try {
    const image = new Image(); image.src = preview.url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    try {
      const context = canvas.getContext('2d'); if (!context) return preview;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .78));
      if (!blob) return preview;
      const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
      return url.length < preview.url.length ? { ...preview, url } : preview;
    } finally { canvas.width = 0; canvas.height = 0; }
  } catch { return preview; }
}

/** Fingerprint the local file record without decoding or rendering the PDF. */
export async function materialCoverStamp(setId: string, materialId: string, page: MaterialPage): Promise<string | null> {
  if (page.kind !== 'pdf' || !globalThis.crypto?.subtle) return null;
  const owner = getAccountStorageSession(), key = materialFileKey(setId, materialId);
  try {
    owner?.assertCurrent();
    const legacy = accountLocalStorage.getItem(key);
    const db = await openAppDb();
    const tx = db.transaction(['categoryNotes', 'appRecords'], 'readonly');
    const source = tx.objectStore('categoryNotes').get(key);
    const record = tx.objectStore('appRecords').get(appRecordKey('indexedDbNotes', key));
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
    if (owner !== getAccountStorageSession()) return null;
    owner?.assertCurrent();
    const row = record.result;
    if (row && (row.raw === null || row.id !== key || row.collection !== 'indexedDbNotes')) return null;
    const raw = legacy !== null ? await loadCategoryNoteRaw(key) : source.result;
    if (typeof raw !== 'string') return null;
    const sample = JSON.stringify([setId, materialId, page.id, page.pdfPage, row?.localRevision, row?.serverRevision, raw.length, raw.slice(0, 4096), raw.slice(-4096)]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sample));
    if (owner !== getAccountStorageSession()) return null;
    owner?.assertCurrent();
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

function scopedKey(stamp: string) { return `${accountDatabaseName('quiz-make-material-cover-v1')}:${stamp}`; }
function remember(key: string, preview: MaterialPagePreview) {
  memory.delete(key); memory.set(key, preview);
  while (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value!);
}
function openCache(): Promise<IDBDatabase> {
  const name = accountDatabaseName('quiz-make-material-cover-v1');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('covers', { keyPath: 'key' }).createIndex('used', 'used');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('表紙の保存先を開けません。'));
    request.onsuccess = () => resolve(request.result);
  });
}

/** Disposable, account-scoped thumbnails never enter sync or backups. */
export async function readMaterialCover(stamp: string): Promise<MaterialPagePreview | null> {
  const owner = getAccountStorageSession();
  try {
    const key = scopedKey(stamp), existing = memory.get(key);
    if (existing) { remember(key, existing); return existing; }
    const db = await openCache();
    try {
      if (owner !== getAccountStorageSession()) return null;
      owner?.assertCurrent();
      const tx = db.transaction('covers', 'readwrite'), store = tx.objectStore('covers'), request = store.get(stamp);
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, used: Date.now() }); };
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
      if (owner !== getAccountStorageSession()) return null;
      owner?.assertCurrent();
      const entry = request.result as Entry | undefined;
      if (!entry || typeof entry.url !== 'string' || !entry.url.startsWith('data:image/') || entry.url.length > MAX_URL_LENGTH || !Number.isFinite(entry.aspect) || entry.aspect <= 0) return null;
      const result = { url: entry.url, aspect: entry.aspect, pixelWidth: entry.pixelWidth };
      remember(key, result); return result;
    } finally { db.close(); }
  } catch { return null; }
}

export async function writeMaterialCover(stamp: string, preview: MaterialPagePreview): Promise<void> {
  if (!preview.url || preview.url.length > MAX_URL_LENGTH) return;
  const owner = getAccountStorageSession();
  try {
    const key = scopedKey(stamp); remember(key, preview);
    const db = await openCache();
    try {
      if (owner !== getAccountStorageSession()) return;
      owner?.assertCurrent();
      const tx = db.transaction('covers', 'readwrite'), store = tx.objectStore('covers');
      store.put({ key: stamp, url: preview.url, aspect: preview.aspect, pixelWidth: preview.pixelWidth, used: Date.now() } satisfies Entry);
      const count = store.count();
      count.onsuccess = () => {
        let remove = Math.max(0, count.result - MAX_ENTRIES);
        if (!remove) return;
        const cursor = store.index('used').openCursor();
        cursor.onsuccess = () => { const item = cursor.result; if (item && remove > 0) { item.delete(); remove--; item.continue(); } };
      };
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
    } finally { db.close(); }
  } catch { /* A disposable cache must never prevent opening the original. */ }
}
