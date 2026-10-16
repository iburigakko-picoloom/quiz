import type { AppData, AnswerLog, Question, QuestionProgress } from '../types';
import { normalizeAppData } from './appDataValidation';
import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import type { RecordConflict } from './recordSyncPull';

export type ArchivedRecordConflict = { id: string; conflict: RecordConflict; savedAt: string; choice?: string };
export async function markRecoveredOriginalReviewed(db: IDBDatabase, id: string): Promise<void> {
  const { idbDone } = await import('./blobVault');
  const tx = db.transaction('appRecordConflicts','readwrite'), done = idbDone(tx), store = tx.objectStore('appRecordConflicts'), row = store.get(id);
  row.onsuccess = () => { if(row.result?.kind === 'legacy-recovery-candidate') store.put({...row.result, kind:'reviewed-recovery-original', choice:'reviewed', resolvedAt:new Date().toISOString()},id); };
  await done;
}
export async function listProtectedOriginals(db: IDBDatabase): Promise<string[]> {
  const {idbDone,idbResult} = await import('./blobVault');
  const tx=db.transaction('appDataBackups'),done=idbDone(tx),keys=await idbResult(tx.objectStore('appDataBackups').getAllKeys()); await done;
  return keys.map(String).filter(key=>/^(note-rescue:|delta-note-original:|legacy-original:)/u.test(key));
}
export async function readProtectedOriginal(db: IDBDatabase, id: string): Promise<string> {
  const {idbDone,idbResult,unpackBlobNote}=await import('./blobVault');
  const tx=db.transaction('appDataBackups'),done=idbDone(tx),value=await idbResult(tx.objectStore('appDataBackups').get(id));await done;
  const raw=value instanceof Blob?await value.text():value;if(typeof raw!=='string')throw new Error('復旧原本を読み出せません。');
  return unpackBlobNote(db,raw,async ref=>(await import('./blobCloud')).downloadContentBlob(ref));
}
export async function readArchivedRecordConflicts(db: IDBDatabase, connection: RecordSyncConnection): Promise<ArchivedRecordConflict[]> {
  const tx = db.transaction('appRecordConflicts', 'readonly');
  const completion = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('復旧用の原本を読み取れませんでした。')); });
  const store = tx.objectStore('appRecordConflicts');
  const values = store.getAll(); const keys = store.getAllKeys();
  await completion;
  const conflicts:ArchivedRecordConflict[]=values.result.flatMap((item, index) => item.conflict?.connection && sameRecordSyncConnection(item.conflict.connection, connection)
    ? [{ id: String(keys.result[index]), conflict: item.conflict, savedAt: item.resolvedAt ?? item.archivedAt ?? '', choice: item.choice }] : [])
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  if(db.objectStoreNames.contains('recordHistory')){
    const read=db.transaction(['recordHistory','appRecords']),complete=new Promise<void>((r,j)=>{read.oncomplete=()=>r();read.onabort=()=>j(read.error);});
    const history=read.objectStore('recordHistory').openCursor();
    history.onsuccess=()=>{const cursor=history.result;if(!cursor)return;const versions=cursor.value as import('./appRecordStorage').AppRecord[],current=read.objectStore('appRecords').get(cursor.key);
      current.onsuccess=()=>{const remote=current.result;if(remote)versions.forEach((local,index)=>{conflicts.push({id:`history:${String(cursor.key)}:${index}`,savedAt:'',choice:'history',conflict:{connection,key:local.key,operationId:null,local,remote:{...remote,revision:remote.serverRevision}}});});};cursor.continue();};await complete;
  }
  return conflicts;
}

/** User-chosen restoration is a new local edit. The old version is never given
 * a new timestamp merely by reading this recovery list. */
export async function restoreRecoveredRecord(db:IDBDatabase,conflict:RecordConflict,side:'local'|'remote'):Promise<void>{
  const record=side==='local'?conflict.local:conflict.remote;if(!record)throw new Error('この版の原本がありません。');
  if(record.collection==='indexedDbNotes'){
    if(record.raw===null)throw new Error('削除版は現在のノート画面から削除してください。');
    const {unpackBlobNote}=await import('./blobVault'),{downloadContentBlob}=await import('./blobCloud');
    const value=JSON.parse(await unpackBlobNote(db,record.raw,downloadContentBlob));value.updatedAt=new Date().toISOString();
    await (await import('./noteStorage')).saveCategoryNoteRaw(record.id,JSON.stringify(value));return;
  }
  if(!['folders','problemSets','questions','progress','answerLogs'].includes(record.collection))throw new Error('この原本はJSONを書き出して確認してください。');
  const {withCoordinatedDataMutation}=await import('./dataCoordination');
  await withCoordinatedDataMutation(['app','notes'],async()=>{
    const {readCurrentAppRecordSnapshot,materializeAppRecords}=await import('./appRecordStorage'),snapshot=await readCurrentAppRecordSnapshot(db);if(!snapshot)throw new Error('現在の保存状態を確認できません。');
    const records=new Map(snapshot.records),old=records.get(record.key),value=record.raw?JSON.parse(record.raw):null;
    if(value&&['folders','problemSets','questions'].includes(record.collection))value.updatedAt=new Date().toISOString();
    records.set(record.key,{...record,raw:value?JSON.stringify(value):null,serverRevision:old?.serverRevision??0,localRevision:snapshot.state.revision+1});
    const counts={...snapshot.state.counts},collection=record.collection as keyof typeof counts;counts[collection]+=Number(value!==null)-Number(old?.raw!=null);
    const data=materializeAppRecords({records,state:{...snapshot.state,counts}});
    if(!await(await import('../storage')).saveAppDataAsync(data,{coordinationLockHeld:true}))throw new Error('復元を保存できません。原本を保持しています。');
  },{requireCrossContext:true});
}

/** Make a separate problem and progress copy. The current version and both raw
 * originals remain intact. Missing history is never synthesized or merged. */
export function createConflictRecoveryCopy(data: AppData, conflict: RecordConflict, side: 'local' | 'remote', now = new Date().toISOString()): AppData {
  const raw = side === 'local' ? conflict.local?.raw : conflict.remote.raw;
  if (!raw) throw new Error('削除された版は原本JSONで確認してください。');
  const value = JSON.parse(raw);
  const collection = conflict.remote.collection;
  const sourceId = collection === 'progress' || collection === 'questions' ? conflict.remote.id : value.questionId;
  const question = collection === 'questions' ? value as Question : data.questions.find(item => item.id === sourceId);
  if (!['questions', 'progress', 'answerLogs'].includes(collection) || !question) throw new Error('この内容は原本JSONを書き出して復旧してください。');
  // Preserve image/material IDs only on the existing problem. A separate copy
  // must not claim ownership of blobs or descriptors that have not been copied.
  if (question.questionImageIds?.length || question.detailedAnswer?.imageIds?.length || question.materialReferences?.length) throw new Error('画像・資料付きの内容は原本JSONを書き出して復旧してください。');
  const folderId = crypto.randomUUID(), setId = crypto.randomUUID(), questionId = crypto.randomUUID();
  const set = data.problemSets.find(item => item.id === question.setId);
  const copy: AppData = structuredClone(data);
  copy.folders.push({ id: folderId, name: '同期の復旧コピー', createdAt: now, updatedAt: now });
  copy.problemSets.push({ id: setId, folderId, title: `${set?.title ?? '問題'}（${side === 'local' ? '端末' : 'クラウド'}の復旧コピー）`, source: set?.source ?? '', creationMethod: 'copy', visibility: 'private', createdAt: now, updatedAt: now });
  copy.questions.push({ ...question, id: questionId, setId, createdAt: now, updatedAt: now });
  if (collection === 'progress') copy.progress.push({ ...value as QuestionProgress, questionId });
  if (collection === 'answerLogs') copy.answerLogs.push({ ...value as AnswerLog, id: crypto.randomUUID(), questionId, setId, folderId });
  const normalized = normalizeAppData(copy);
  if (!normalized.ok || normalized.data.questions.length !== copy.questions.length || normalized.data.answerLogs.length !== copy.answerLogs.length) throw new Error('復旧コピーの内容を検証できませんでした。原本は保持しています。');
  if (collection === 'progress') {
    const actual = normalized.data.progress.find(item => item.questionId === questionId);
    const expected = copy.progress.find(item => item.questionId === questionId);
    if (!actual || Object.keys(expected!).some(key => JSON.stringify(actual[key as keyof QuestionProgress]) !== JSON.stringify(expected![key as keyof QuestionProgress]))) throw new Error('学習状態を完全に復旧できません。原本JSONを確認してください。');
  }
  return normalized.data;
}
