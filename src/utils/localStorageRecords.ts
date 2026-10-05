import { accountLocalStorage as localStorage } from './accountStorage';
import { openAppDb } from '../storage';
import { openCoLocatedNoteDb } from './noteRecordMigration';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import { validQuestionImageDescriptor } from './questionImageRecords';
import { isChunkInternal } from './recordChunkFormat';
import { isLearningStorageKey, LEARNING_MIGRATED_KEY, LEARNING_REQUIRED_KEY } from './learningStorageKeys';
import { migrateLearningStorage, prepareLearningValue, queueLearningValue, queueLearningFence, refreshLearningStorage, readLearningValues } from './learningValueStorage';

export const LOCAL_PROJECTION_STORE = 'localProjections';
const STORES = ['appData', 'appRecordMeta', 'appRecords', 'appRecordBackups', 'appOutbox', LOCAL_PROJECTION_STORE];
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve,reject) => { tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(tx.error ?? new Error('メモの保存を完了できませんでした。')); });
}
function project(key: string, raw: string | null): void {
  if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key,raw);
  if (localStorage.getItem(key) !== raw) throw new Error('メモの保存を確認できませんでした。再読み込みしてください。');
}

/** Caller holds the origin data lock. IndexedDB is authoritative; localStorage
 * is a synchronous UI cache. A crash between commit and projection is replayable.
 */
export async function saveSyncedLocalStorage(entries: Record<string, string | null>, onCommitted?: () => void): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    for (const [key,raw] of Object.entries(entries)) project(key,raw);
    onCommitted?.();
    return;
  }
  const db = await openCoLocatedNoteDb();
  await replayLocalStorageProjections(db, Object.keys(entries));
  const previous = await readLearningValues(db);
  const learning = new Map(await Promise.all(Object.entries(entries).filter(([key]) => isLearningStorageKey(key)).map(async ([key, raw]) => [key, { ...await prepareLearningValue(key, raw), ...(previous.get(key)?.nativeCleanup ? { nativeCleanup: previous.get(key)!.nativeCleanup } : {}) }] as const)));
  const tx=db.transaction(STORES,'readwrite'); const completion=done(tx);
  try {
    if (learning.size) queueLearningFence(tx);
    for (const [key,raw] of Object.entries(entries)) {
      queueAuxiliaryRecordWrite(tx,'localStorage',key,raw);
      const value = learning.get(key);
      if (value) queueLearningValue(tx, value); else tx.objectStore(LOCAL_PROJECTION_STORE).put(raw,key);
    }
    await completion;
  } catch (error) { try { tx.abort(); } catch { /* transaction finished */ } await completion.catch(() => {}); throw error; }
  onCommitted?.();
  await refreshLearningStorage(db);
  await replayLocalStorageProjections(db, Object.keys(entries));
}

/** Run before mounting screens and after a Pull commit, while holding the origin
 * lock. If projection fails, leave the intent and prevent stale UI writes.
 */
export async function replayLocalStorageProjections(db?: IDBDatabase, onlyKeys?: readonly string[]): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    if (localStorage.getItem(LEARNING_MIGRATED_KEY) === '1') throw new Error('学習データをIndexedDBから読み込めません。元のデータを保持し、空の状態での保存を止めました。');
    return;
  }
  db ??= await openAppDb();
  await migrateLearningStorage(db);
  const read=db.transaction(LOCAL_PROJECTION_STORE); const readDone=done(read);
  const keys=read.objectStore(LOCAL_PROJECTION_STORE).getAllKeys();
  const values=read.objectStore(LOCAL_PROJECTION_STORE).getAll();
  await readDone;
  const projected: number[] = [], failures: unknown[] = [];
  for (let index=0;index<keys.result.length;index++) {
    const key=keys.result[index]; const raw=values.result[index];
    if (key === LEARNING_REQUIRED_KEY && raw?.schema === 1 && raw?.kind === 'quiz-learning-idb-required' && Object.keys(raw).length === 2) continue;
    if (typeof key !== 'string' || !(raw === null || typeof raw === 'string')) throw new Error('保存済みメモの形式を確認できませんでした。');
    if (onlyKeys && !onlyKeys.includes(key)) continue;
    try { project(key,raw); projected.push(index); } catch (error) { failures.push(error); }
  }
  if (!projected.length) { if (failures.length) throw failures[0]; return; }
  const ack=db.transaction(LOCAL_PROJECTION_STORE,'readwrite'); const ackDone=done(ack);
  projected.forEach(index=>{
    const key = keys.result[index];
    const current=ack.objectStore(LOCAL_PROJECTION_STORE).get(key);
    current.onsuccess=()=>{if(current.result===values.result[index]) ack.objectStore(LOCAL_PROJECTION_STORE).delete(key);};
  });
  await ackDone;
  // A remote preference or a restored file must refresh the mounted character
  // in this same tab; browsers do not send it a storage event for this write.
  if (projected.some(index => keys.result[index] === 'quiz-make-study-companion') && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('quiz-make-study-companion-change'));
  }
  if (failures.length) throw failures[0];
}

/** Capture legacy synchronized keys without opening AppData records. Ordinary
 * memo writes use saveSyncedLocalStorage; this also catches older settings.
 */
export async function captureSyncedLocalStorage(isSyncKey: (key: string) => boolean): Promise<number> {
  if (typeof indexedDB === 'undefined') throw new Error('差分同期にはIndexedDBが必要です。');
  const db = await openCoLocatedNoteDb();
  await replayLocalStorageProjections(db);
  const values = new Map<string,string>();
  for (let index=0;index<localStorage.length;index++) {
    const key=localStorage.key(index);
    if (!key || !isSyncKey(key) || isChunkInternal('localStorage',key) || key==='quiz-make-app-data-v1' || key.startsWith('quizMake:notes:')) continue;
    const raw=localStorage.getItem(key);
    if (raw!==null && !isImagePointer(key,raw)) values.set(key,raw);
  }
  const tx=db.transaction(STORES,'readwrite'); const completion=done(tx);
  let count=0;
  const prefix='["localStorage",';
  const cursor=tx.objectStore('appRecords').openCursor(IDBKeyRange.bound(prefix,`${prefix}\uffff`));
  cursor.onsuccess=()=>{
    const current=cursor.result;
    if (!current) {
      values.forEach((raw,key)=>{queueAuxiliaryRecordWrite(tx,'localStorage',key,raw);count++;});
      return;
    }
    const row=current.value as {id:string;raw:string|null;logicalRaw?:string};
    if (isChunkInternal('localStorage',row.id)) { current.continue(); return; }
    if (!isSyncKey(row.id) || (row.raw !== null && isImagePointer(row.id,row.raw))) { current.continue(); return; }
    const raw=values.get(row.id) ?? null;
    if (raw!==(row.logicalRaw??row.raw)) { queueAuxiliaryRecordWrite(tx,'localStorage',row.id,raw); count++; }
    values.delete(row.id);
    current.continue();
  };
  await completion;
  return count;
}

function isImagePointer(key: string, raw: string): boolean {
  if (!key.startsWith('quizMake:image:')) return false;
  try { const value: unknown = JSON.parse(raw); return validQuestionImageDescriptor(value) && value.id === key.slice('quizMake:image:'.length); }
  catch { return false; }
}
