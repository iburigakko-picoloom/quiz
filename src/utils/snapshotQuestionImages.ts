import { APP_DATA_STORAGE_KEY } from '../storage';
import type { AppData } from '../types';
import type { SyncPayload } from './syncService';
import type { AppRecord } from './appRecordStorage';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import { advanceLocalDataRevision } from './localDataRevision';
import { IMAGE_BLOB_STORE, IMAGE_SYNC_STORES, describeQuestionImage, openQuestionImageRecordDb, questionImageMetadataKey, readQuestionImages, validQuestionImageDescriptor, type QuestionImageDescriptor, type StoredQuestionImage } from './questionImageRecords';
import { remoteQuestionImageDescriptor, storedQuestionImage, verifyQuestionImageBlob, type QuestionImageTransport } from './questionImageCloud';

type SnapshotImage = QuestionImageDescriptor & { dataUrl?: string };
export const isSnapshotImageKey = (key: string) => key.startsWith('quizMake:image:');

function references(payload: SyncPayload): Map<string, string> {
  const data = JSON.parse(payload.localStorage[APP_DATA_STORAGE_KEY]) as AppData;
  const result = new Map<string, string>();
  for (const question of data.questions) {
    for (const id of new Set([...(question.questionImageIds ?? []), ...(question.detailedAnswer?.imageIds ?? [])])) {
      if (result.has(id) && result.get(id) !== question.id) throw new Error('問題画像の参照先が重複しています。');
      result.set(id, question.id);
    }
  }
  return result;
}

function entries(payload: SyncPayload): Array<[string, SnapshotImage]> {
  return Object.entries(payload.localStorage).filter(([key]) => isSnapshotImageKey(key)).map(([key, raw]) => {
    const image = JSON.parse(raw) as SnapshotImage;
    if (!validQuestionImageDescriptor(image) || questionImageMetadataKey(image.id) !== key
      || (image.dataUrl !== undefined && typeof image.dataUrl !== 'string')) throw new Error('問題画像の保存情報が不正です。');
    return [key, image];
  });
}

export function validateSnapshotQuestionImages(payload: SyncPayload, wire = false): void {
  const required = references(payload);
  for (const [, image] of entries(payload)) {
    if (required.get(image.id) !== image.questionId) throw new Error('問題と画像の参照が一致しません。');
    if (wire ? !image.path || image.dataUrl !== undefined : !image.dataUrl) throw new Error('問題画像の本体が未取得です。画像を含むクラウドデータまたはバックアップを選んでください。');
    required.delete(image.id);
  }
  if (required.size) throw new Error('問題画像の本体が見つかりません。元の端末で画像を含むバックアップを保存してください。');
}

function encode(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    const parts: string[] = [];
    for (let index = 0; index < bytes.length; index += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
    return `data:${blob.type};base64,${btoa(parts.join(''))}`;
  });
}
function decode(image: SnapshotImage): Blob {
  const prefix = `data:${image.type};base64,`;
  if (!image.dataUrl?.startsWith(prefix)) throw new Error('バックアップ画像の形式が不正です。');
  const encoded = image.dataUrl.slice(prefix.length);
  if (encoded.length !== 4 * Math.ceil(image.size / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('バックアップ画像のサイズが一致しません。');
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return new Blob([bytes], { type: image.type });
}
async function portable(image: StoredQuestionImage, descriptor: QuestionImageDescriptor): Promise<string> {
  const { path: _path, ...local } = descriptor;
  return JSON.stringify({ ...local, dataUrl: await encode(image.blob) });
}

/** Original Blobs remain in IndexedDB. Every referenced image is included in the portable backup. */
export async function exportSnapshotQuestionImages(payload: SyncPayload): Promise<SyncPayload> {
  const localStorage = Object.fromEntries(Object.entries(payload.localStorage).filter(([key]) => !isSnapshotImageKey(key)));
  for (const [id, questionId] of references(payload)) {
    const [image] = await readQuestionImages(questionId, [id]);
    if (!image) throw new Error('問題画像の本体が見つからないため、同期とバックアップを中止しました。元の端末を確認してください。');
    localStorage[questionImageMetadataKey(id)] = await portable(image, await describeQuestionImage(image));
  }
  return { ...payload, localStorage };
}

/** Metadata is small; image bodies are sent separately and do not consume the JSON limit. */
export function snapshotImageMetadataOnly(payload: SyncPayload, comparison = false): SyncPayload {
  const localStorage = { ...payload.localStorage };
  for (const [key, image] of entries(payload)) {
    const { dataUrl: _body, path, ...descriptor } = image;
    const metadata = comparison ? descriptor : { ...descriptor, ...(path ? { path } : {}) };
    localStorage[key] = JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))));
  }
  return { ...payload, localStorage };
}
export const hasSnapshotQuestionImages = (payload: SyncPayload) => Object.keys(payload.localStorage).some(isSnapshotImageKey);

export async function verifySnapshotQuestionImages(payload: SyncPayload): Promise<StoredQuestionImage[]> {
  validateSnapshotQuestionImages(payload);
  const result: StoredQuestionImage[] = [];
  for (const [, descriptor] of entries(payload)) {
    const blob = decode(descriptor);
    if (!await verifyQuestionImageBlob(blob, descriptor)) throw new Error('問題画像の内容が保存情報と一致しません。現在のデータは変更していません。');
    result.push(storedQuestionImage(descriptor, blob));
  }
  return result;
}

export async function prepareSnapshotQuestionImageUpload(payload: SyncPayload, transport: QuestionImageTransport): Promise<SyncPayload> {
  const bodies = await verifySnapshotQuestionImages(payload);
  const localStorage = { ...payload.localStorage };
  const descriptors = entries(payload);
  const checked = new Set<string>();
  for (let index = 0; index < bodies.length; index++) {
    const [key, image] = descriptors[index];
    const { dataUrl: _body, ...descriptor } = image;
    const remote = remoteQuestionImageDescriptor(descriptor, transport.userId);
    if (!checked.has(remote.path!)) {
      if (!await transport.exists(remote)) await transport.upload(remote, bodies[index].blob);
      checked.add(remote.path!);
    }
    localStorage[key] = JSON.stringify(remote);
  }
  return { ...payload, localStorage };
}

/** Downloads and hash checks finish before any live data is replaced. */
export async function hydrateSnapshotQuestionImages(payload: SyncPayload, transport: QuestionImageTransport): Promise<SyncPayload> {
  validateSnapshotQuestionImages(payload, true);
  const localStorage = { ...payload.localStorage };
  for (const [key, descriptor] of entries(payload)) {
    if (descriptor.path !== remoteQuestionImageDescriptor(descriptor, transport.userId).path) throw new Error('問題画像の所有者が現在のアカウントと一致しません。');
    let existing: StoredQuestionImage | undefined;
    try { [existing] = await readQuestionImages(descriptor.questionId, [descriptor.id]); } catch { /* Cache is optional. */ }
    const blob = existing && await verifyQuestionImageBlob(existing.blob, descriptor) ? existing.blob : await transport.download(descriptor);
    if (!await verifyQuestionImageBlob(blob, descriptor)) throw new Error('クラウドの問題画像を検証できませんでした。端末データは変更していません。');
    localStorage[key] = await portable(storedQuestionImage(descriptor, blob), descriptor);
  }
  return { ...payload, localStorage };
}

/** Caller holds the origin mutation lock. Blobs and their record descriptors commit together. */
export async function replaceSnapshotQuestionImages(payload: SyncPayload): Promise<void> {
  const images = await verifySnapshotQuestionImages(payload);
  // Old image-free backups need no new image database when IndexedDB is unavailable.
  if (typeof indexedDB === 'undefined') {
    if (images.length) throw new Error('この端末では問題画像を保存できません。');
    return;
  }
  const db = await openQuestionImageRecordDb();
  const descriptors = await Promise.all(images.map(describeQuestionImage));
  const selected = new Set(images.map(image => image.id));
  const tx = db.transaction(IMAGE_SYNC_STORES, 'readwrite');
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('問題画像を保存できませんでした。'));
  });
  const cursor = tx.objectStore('appRecords').openCursor();
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (!row) return;
    const record = row.value as AppRecord;
    if (record.collection === 'questionImages' && record.raw !== null && !selected.has(record.id)) queueAuxiliaryRecordWrite(tx, 'questionImages', record.id, null);
    row.continue();
  };
  images.forEach((image, index) => {
    tx.objectStore(IMAGE_BLOB_STORE).put(image, image.id);
    queueAuxiliaryRecordWrite(tx, 'questionImages', image.id, JSON.stringify(descriptors[index]));
  });
  await completion;
  if (images.length) advanceLocalDataRevision();
}
