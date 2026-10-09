import { APP_COLLECTIONS, materializeAppRecords, type AppRecord } from './appRecordStorage';
import { isChunkInternal } from './recordChunkFormat';
import type { RemoteRecordChange } from './recordSyncPull';
import { createCompleteFileBackup, createImageOptionalSyncFile, type FileBackup } from './backupPayload';
import { hydrateMaterialDownload, type MaterialTransport } from './materialCloud';
import type { StoredQuestionImage } from './questionImageRecords';
import { isQuizMakeStorageKey, type SyncPayload } from './syncService';
import type { SyncProgress } from './syncAttemptStatus';
import { SyncProtocolError } from './syncInterruption';
import type { AppData } from '../types';
import { assertMaterialIntegrity, SyncDataError, syncDataFailure, type SyncFailureDetails } from './syncDataIntegrity';
import { materialFileEntry } from './materialModel';

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
export async function buildWholeIncomingFile(db:IDBDatabase,rows:RemoteRecordChange[],transport:MaterialTransport,assertCurrent:()=>Promise<void>,progress?:(value:SyncProgress)=>void,allowMissingImages=false):Promise<FileBackup>{
  const source=wholeRowsPayload(rows),data=JSON.parse(source.localStorage['quiz-make-app-data-v1']) as AppData;
  try{progress?.({label:'資料の紐づけを確認中',completed:0,total:1,stage:'checking_materials'});}catch{}
  assertMaterialIntegrity(source,data,false);
  const metadata=new Set(rows.filter(row=>row.collection==='questionImages'&&row.raw!==null).map(row=>row.id));
  const missing=new Set(data.questions.flatMap(question=>[...(question.questionImageIds??[]),...(question.detailedAnswer?.imageIds??[])]).filter(id=>!metadata.has(id)));
  if(missing.size&&!allowMissingImages)throw new SyncDataError('image_reference','一部の画像の紐づけ情報を確認できません。',{function:'buildWholeIncomingFile',stage:'material_references',cause:'missing',total:missing.size,completed:0});
  const tx=db.transaction('appPullMedia'),completed=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)}),request=tx.objectStore('appPullMedia').getAll();await completed;
  const staged=request.result as Array<{image?:StoredQuestionImage}>;
  const images=staged.filter((row):row is {image:StoredQuestionImage}=>Boolean(row.image)).map(row=>row.image);
  await assertCurrent();
  let pdfDiagnostic:SyncFailureDetails|undefined;
  const payload=await hydrateMaterialDownload(source,transport,undefined,(completed,total)=>{try{progress?.({label:'資料を確認・受信中',completed,total,stage:'receiving_materials'});}catch{/* Informational only. */}},{assertCurrent,diagnostic:value=>{pdfDiagnostic=value;},localFile:async key=>{
    await assertCurrent();const read=db.transaction('categoryNotes'),done=new Promise<void>((resolve,reject)=>{read.oncomplete=()=>resolve();read.onabort=()=>reject(read.error);}),value=read.objectStore('categoryNotes').get(key);await done;return typeof value.result==='string'?materialFileEntry(key,value.result):null;
  }});
  await assertCurrent();
  try{progress?.({label:'バックアップを生成・検証中',completed:0,total:1,stage:'building_backup'});}catch{}
  try{
    const file=await (allowMissingImages?createImageOptionalSyncFile(payload,images):createCompleteFileBackup(payload,images));await assertCurrent();
    try{progress?.({label:'バックアップの検証完了',completed:1,total:1,stage:'building_backup'});}catch{}return file;
  }catch(error){if(error instanceof SyncProtocolError&&!(error instanceof SyncDataError))throw error;const failure=syncDataFailure(error,'createFileBackup','backup_build');if(pdfDiagnostic)Object.assign(failure.diagnostic,{pdfTotal:pdfDiagnostic.total,pdfCompleted:pdfDiagnostic.completed,downloaded:pdfDiagnostic.downloaded,cacheReused:pdfDiagnostic.cacheReused,localReused:pdfDiagnostic.localReused});throw failure;}
}
