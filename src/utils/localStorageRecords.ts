import { openAppDb } from '../storage';
import { openCoLocatedNoteDb } from './noteRecordMigration';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import { validQuestionImageDescriptor } from './questionImageRecords';

export const LOCAL_PROJECTION_STORE = 'localProjections';
const STORES = ['appRecordMeta', 'appRecords', 'appRecordBackups', 'appOutbox', LOCAL_PROJECTION_STORE];
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
export async function saveSyncedLocalStorage(entries: Record<string, string | null>): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    for (const [key,raw] of Object.entries(entries)) project(key,raw);
    return;
  }
  const db = await openCoLocatedNoteDb();
  await replayLocalStorageProjections(db);
  const tx=db.transaction(STORES,'readwrite'); const completion=done(tx);
  for (const [key,raw] of Object.entries(entries)) {
    queueAuxiliaryRecordWrite(tx,'localStorage',key,raw);
    tx.objectStore(LOCAL_PROJECTION_STORE).put(raw,key);
  }
  await completion;
  await replayLocalStorageProjections(db);
}

/** Run before mounting screens and after a Pull commit, while holding the origin
 * lock. If projection fails, leave the intent and prevent stale UI writes.
 */
export async function replayLocalStorageProjections(db?: IDBDatabase): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  db ??= await openAppDb();
  const read=db.transaction(LOCAL_PROJECTION_STORE); const readDone=done(read);
  const keys=read.objectStore(LOCAL_PROJECTION_STORE).getAllKeys();
  const values=read.objectStore(LOCAL_PROJECTION_STORE).getAll();
  await readDone;
  for (let index=0;index<keys.result.length;index++) {
    const key=keys.result[index]; const raw=values.result[index];
    if (typeof key !== 'string' || !(raw === null || typeof raw === 'string')) throw new Error('保存済みメモの形式を確認できませんでした。');
    project(key,raw);
  }
  if (!keys.result.length) return;
  const ack=db.transaction(LOCAL_PROJECTION_STORE,'readwrite'); const ackDone=done(ack);
  keys.result.forEach((key,index)=>{
    const current=ack.objectStore(LOCAL_PROJECTION_STORE).get(key);
    current.onsuccess=()=>{if(current.result===values.result[index]) ack.objectStore(LOCAL_PROJECTION_STORE).delete(key);};
  });
  await ackDone;
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
    if (!key || !isSyncKey(key) || key==='quiz-make-app-data-v1' || key.startsWith('quizMake:notes:')) continue;
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
    const row=current.value as {id:string;raw:string|null};
    if (!isSyncKey(row.id) || (row.raw !== null && isImagePointer(row.id,row.raw))) { current.continue(); return; }
    const raw=values.get(row.id) ?? null;
    if (raw!==row.raw) { queueAuxiliaryRecordWrite(tx,'localStorage',row.id,raw); count++; }
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
