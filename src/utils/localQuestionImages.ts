import { createId } from './id';
import { MAX_LOCAL_QUESTION_IMAGE_BYTES, MAX_QUESTION_DETAIL_IMAGES } from './imageLimits';
import { requestPersistentStorage } from './noteStorage';

const DATABASE_NAME = 'quiz-make-local-question-images-v1';
const DATABASE_VERSION = 1;
const IMAGE_STORE_NAME = 'images';
export { MAX_LOCAL_QUESTION_IMAGE_BYTES, MAX_QUESTION_DETAIL_IMAGES } from './imageLimits';

export interface LocalQuestionImage {
  id: string;
  questionId: string;
  name: string;
  type: string;
  blob: Blob;
  addedAt: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

export async function saveLocalQuestionImage(questionId: string, file: Blob, id = createId('image')): Promise<string> {
  validateImageFile(file);
  if (!questionId.trim()) throw new Error('画像の保存先を確認できません。');
  void requestPersistentStorage();
  const database = await openDatabase();
  const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite');
  const completed = transactionDone(transaction);
  const record: LocalQuestionImage = {
    id,
    questionId,
    name: typeof File !== 'undefined' && file instanceof File && file.name ? file.name : '共有画像',
    type: file.type,
    blob: new Blob([file], { type: file.type }),
    addedAt: new Date().toISOString(),
  };
  transaction.objectStore(IMAGE_STORE_NAME).put(record);
  await completed;
  return id;
}

export async function loadLocalQuestionImages(questionId: string, imageIds: readonly string[]): Promise<LocalQuestionImage[]> {
  if (!imageIds.length) return [];
  const database = await openDatabase();
  const transaction = database.transaction(IMAGE_STORE_NAME, 'readonly');
  const completed = transactionDone(transaction);
  const records = await requestResult<LocalQuestionImage[]>(
    transaction.objectStore(IMAGE_STORE_NAME).index('questionId').getAll(IDBKeyRange.only(questionId)),
  );
  await completed;
  const byId = new Map(records.map(record => [record.id, record]));
  return imageIds.map(id => byId.get(id)).filter((record): record is LocalQuestionImage => Boolean(record));
}

export async function deleteLocalQuestionImage(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite');
  const completed = transactionDone(transaction);
  transaction.objectStore(IMAGE_STORE_NAME).delete(id);
  await completed;
}

export async function deleteLocalQuestionImages(questionId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite');
  const completed = transactionDone(transaction);
  const cursorRequest = transaction.objectStore(IMAGE_STORE_NAME).index('questionId').openKeyCursor(IDBKeyRange.only(questionId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await completed;
}

export async function pruneLocalQuestionImages(questionIds: Iterable<string>): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const keep = new Set(questionIds);
  const database = await openDatabase();
  const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite');
  const completed = transactionDone(transaction);
  const cursorRequest = transaction.objectStore(IMAGE_STORE_NAME).openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const record = cursor.value as LocalQuestionImage;
    if (!keep.has(record.questionId)) cursor.delete();
    cursor.continue();
  };
  await completed;
}

function validateImageFile(file: Blob) {
  if (!/^image\/(png|jpeg|webp|heic|heif)$/.test(file.type)) {
    throw new Error('PNG・JPEG・WebP・HEIC・HEIF画像を選んでください。');
  }
  if (!file.size || file.size > MAX_LOCAL_QUESTION_IMAGE_BYTES) {
    throw new Error('画像は1枚50MB以下にしてください。');
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('この端末では画像を保存できません。'));
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(IMAGE_STORE_NAME)
        ? request.transaction!.objectStore(IMAGE_STORE_NAME)
        : database.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'id' });
      if (!store.indexNames.contains('questionId')) store.createIndex('questionId', 'questionId', { unique: false });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('端末内の画像保存を開けません。'));
    request.onblocked = () => reject(new Error('画像の保存領域を開けません。ほかのタブを閉じて、もう一度お試しください。'));
  }).catch(error => {
    databasePromise = null;
    throw toStorageError(error);
  });
  databasePromise = opening;
  return opening;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('端末内の画像を読み込めません。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(toStorageError(transaction.error));
    transaction.onerror = () => reject(toStorageError(transaction.error));
  });
}

function toStorageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error('端末の画像保存容量が足りません。端末の空き容量を増やしてから、もう一度お試しください。');
  }
  return error instanceof Error ? error : new Error('端末内の画像を保存できませんでした。');
}
