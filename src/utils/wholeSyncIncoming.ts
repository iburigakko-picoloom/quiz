import { APP_COLLECTIONS, materializeAppRecords, type AppRecord } from './appRecordStorage';
import { isChunkInternal } from './recordChunkFormat';
import type { RemoteRecordChange } from './recordSyncPull';
import { createCompleteFileBackup, type FileBackup } from './backupPayload';
import { hydrateMaterialDownload, type MaterialTransport } from './materialCloud';
import type { StoredQuestionImage } from './questionImageRecords';
import { isQuizMakeStorageKey, type SyncPayload } from './syncService';
import type { SyncProgress } from './syncAttemptStatus';

export function wholeRowsPayload(rows:RemoteRecordChange[]):SyncPayload{
  const live=rows.filter(row=>row.raw!==null),counts=Object.fromEntries(APP_COLLECTIONS.map(name=>[name,live.filter(row=>row.collection===name).length])) as Record<typeof APP_COLLECTIONS[number],number>;
  const data=materializeAppRecords({state:{schema:1,revision:1,commitId:'whole',savedAt:new Date().toISOString(),counts},records:new Map(live.map(row=>[row.key,{...row,serverRevision:row.revision,localRevision:1} as AppRecord]))});
  const settings:Record<string,string>={},notes:Record<string,string>={};
  for(const row of live){
    if(isChunkInternal(row.collection,row.id))continue;
    if(row.collection==='localStorage'){
      if(!isQuizMakeStorageKey(row.id)||row.id==='quiz-make-app-data-v1'||row.id.startsWith('quizMake:image:')||row.id.startsWith('quizMake:notes:'))throw new Error('全体受信の設定キーを確認できません。');
      settings[row.id]=row.logicalRaw??row.raw!;
    }
    if(row.collection==='indexedDbNotes')notes[row.id]=row.logicalRaw??row.raw!;
  }
  settings['quiz-make-app-data-v1']=JSON.stringify(data);
  return {version:1,updatedAt:new Date().toISOString(),localStorage:settings,indexedDbNotes:notes};
}
/** Staged attachments are private to this receive; live notes/images stay intact. */
export async function buildWholeIncomingFile(db:IDBDatabase,rows:RemoteRecordChange[],transport:MaterialTransport,assertCurrent:()=>Promise<void>,progress?:(value:SyncProgress)=>void):Promise<FileBackup>{
  const tx=db.transaction('appPullMedia'),completed=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)}),request=tx.objectStore('appPullMedia').getAll();await completed;
  const staged=request.result as Array<{image?:StoredQuestionImage}>;
  const images=staged.filter((row):row is {image:StoredQuestionImage}=>Boolean(row.image)).map(row=>row.image);
  await assertCurrent();
  const payload=await hydrateMaterialDownload(wholeRowsPayload(rows),transport,undefined,(completed,total)=>{try{progress?.({label:'資料を確認・受信中',completed,total,stage:'receiving_materials'});}catch{/* Informational only. */}});
  await assertCurrent();return createCompleteFileBackup(payload,images);
}
