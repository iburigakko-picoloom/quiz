import { getAccountStorageSession, accountLocalStorage } from './accountStorage';
import { readAppRecordSnapshot } from './appRecordStorage';
import type { RemoteRecordChange } from './recordSyncPull';
import type { RecordSyncConnection } from './recordSyncOutbox';
import type { SyncProgress } from './syncAttemptStatus';
import type { QuestionImageTransport } from './questionImageCloud';
import { verifyQuestionImageBlob, storedQuestionImage } from './questionImageCloud';
import type { StoredQuestionImage } from './questionImageRecords';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { hydrateMaterialDownload, type MaterialTransport } from './materialCloud';
import { materialFileEntry } from './materialModel';
import { wholeHash } from './wholeSyncDigest';
import { saveBackupOriginals, type SavedBackup } from './backupRepository';
import { withCoordinatedDataRead } from './dataCoordination';
import { isQuizMakeStorageKey } from './syncService';
import { SyncInterruptedError } from './syncInterruption';

export const SYNC_ORIGINALS_FORMAT='quiz-make-sync-originals-v1';
type ImageOriginal={id:string;questionId:string;name:string;type:string;addedAt:string;dataUrl:string;sha256:string};
type OriginalBody={format:typeof SYNC_ORIGINALS_FORMAT;schema:1;connection:RecordSyncConnection;side:'local'|'remote';revision:number;createdAt:string;localCommitId?:string;records:RemoteRecordChange[];notes:Array<{key:string;raw:unknown}>;nativeValues:Record<string,string>;images:ImageOriginal[];pdfFiles:Record<string,string>;issues:string[]};
export type SyncOriginalsFile=OriginalBody&{originalsDigest:string};
export async function validateSyncOriginalsFile(value:unknown):Promise<boolean>{
  const file=value as SyncOriginalsFile;
  if(!file||file.format!==SYNC_ORIGINALS_FORMAT||file.schema!==1||!file.connection||!['local','remote'].includes(file.side)||!Array.isArray(file.records)||!Array.isArray(file.images)||!Array.isArray(file.notes)||!Array.isArray(file.issues)||typeof file.originalsDigest!=='string')return false;
  const {originalsDigest,...body}=file;
  return originalsDigest===await wholeHash(JSON.stringify(body));
}
async function imageOriginal(image:StoredQuestionImage):Promise<ImageOriginal>{
  const bytes=new Uint8Array(await image.blob.arrayBuffer());let encoded='';
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {id:image.id,questionId:image.questionId,name:image.name,type:image.type,addedAt:image.addedAt,dataUrl:`data:${image.type};base64,${btoa(encoded)}`,sha256};
}
const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('原本を読み取れません。'));});

/** Preserve exact records, available attachments and missing-attachment reasons.
 * This does not normalize, repair or discard the original graph. */
export async function archiveSyncOriginals(db:IDBDatabase,connection:RecordSyncConnection,side:'local'|'remote',rows:RemoteRecordChange[],imageTransport:QuestionImageTransport,materialTransport:MaterialTransport,assertCurrent:()=>Promise<void>,progress?:(value:SyncProgress)=>void):Promise<SavedBackup>{
  const owner=getAccountStorageSession();
  const current=async()=>{if(owner!==getAccountStorageSession())throw new Error('原本のアカウントが変わりました。');owner?.assertCurrent();await assertCurrent();};
  await current();
  const body:OriginalBody={format:SYNC_ORIGINALS_FORMAT,schema:1,connection:{...connection},side,revision:rows.reduce((max,row)=>Math.max(max,row.revision),0),createdAt:new Date().toISOString(),records:structuredClone(rows),notes:[],nativeValues:{},images:[],pdfFiles:{},issues:[]};
  if(side==='local'){
    await withCoordinatedDataRead(['app','notes'],async()=>{
      await current();
      const snapshot=await readAppRecordSnapshot(db);if(!snapshot)throw new Error('端末の原本を読み取れません。');
      body.localCommitId=snapshot.state.commitId;
      body.records=[...snapshot.records.values()].map(row=>({key:row.key,collection:row.collection,id:row.id,raw:row.raw,position:row.position,revision:row.serverRevision,...(row.logicalRaw!==undefined?{logicalRaw:row.logicalRaw}:{})}));
      const tx=db.transaction(['categoryNotes','questionImageBlobs']),completion=done(tx),keys=tx.objectStore('categoryNotes').getAllKeys(),notes=tx.objectStore('categoryNotes').getAll(),images=tx.objectStore('questionImageBlobs').getAll();await completion;await current();
      body.notes=keys.result.map((key,index)=>({key:String(key),raw:notes.result[index]}));
      for(let i=0;i<accountLocalStorage.length;i++){const key=accountLocalStorage.key(i);if(key&&isQuizMakeStorageKey(key)){const raw=accountLocalStorage.getItem(key);if(raw!==null)body.nativeValues[key]=raw;}}
      const originals=images.result as StoredQuestionImage[];
      for(let i=0;i<originals.length;i++){await current();body.images.push(await imageOriginal(originals[i]));try{progress?.({label:'端末の原本を退避中',completed:i+1,total:originals.length,stage:'archiving'});}catch{/* Informational only. */}}
    },{requireCrossContext:true});
  }else{
    const images=rows.filter(row=>row.collection==='questionImages'&&row.raw!==null),pdfs=rows.filter(row=>row.collection==='indexedDbNotes'&&row.raw!==null&&materialFileEntry(row.id,row.logicalRaw??row.raw!)?.kind==='quiz-material-remote-file');
    let completed=0;const total=images.length+pdfs.length;
    for(const row of images){
      await current();
      try{
        const descriptor=parseQuestionImageDescriptor(row.raw);if(descriptor.id!==row.id)throw new Error('画像IDが一致しません。');
        const read=db.transaction('appPullMedia'),complete=done(read),cached=read.objectStore('appPullMedia').get(row.key);await complete;await current();
        const image=cached.result?.image as StoredQuestionImage|undefined;
        const blob=image&&cached.result.revision===row.revision&&JSON.stringify(cached.result.descriptor)===JSON.stringify(descriptor)&&await verifyQuestionImageBlob(image.blob,descriptor)?image.blob:await imageTransport.download(descriptor);
        await current();if(!await verifyQuestionImageBlob(blob,descriptor))throw new Error('画像の内容が一致しません。');body.images.push(await imageOriginal(storedQuestionImage(descriptor,blob)));
      }
      catch(error){await current();if(error instanceof SyncInterruptedError||error&&typeof error==='object'&&'code' in error&&['authentication_required','permission_denied','connection_changed'].includes(String(error.code)))throw error;body.issues.push(`画像本体未収録: ${row.id}`);}
      completed++;try{progress?.({label:'クラウドの原本を退避中',completed,total,stage:'archiving'});}catch{/* Informational only. */}
    }
    for(const row of pdfs){
      await current();try{const hydrated=await hydrateMaterialDownload({version:1,updatedAt:body.createdAt,localStorage:{},indexedDbNotes:{[row.id]:row.logicalRaw??row.raw!}},materialTransport);await current();body.pdfFiles[row.id]=hydrated.indexedDbNotes![row.id];}
      catch(error){await current();if(error instanceof SyncInterruptedError||error&&typeof error==='object'&&'code' in error&&['authentication_required','permission_denied','connection_changed'].includes(String(error.code)))throw error;body.issues.push(`PDF本体未収録: ${row.id}`);}
      completed++;try{progress?.({label:'クラウドの原本を退避中',completed,total,stage:'archiving'});}catch{/* Informational only. */}
    }
    body.issues.push('教材の参照関係を含む受信原本です。通常の一括復元には修復が必要な場合があります。');
  }
  await current();const file:SyncOriginalsFile={...body,originalsDigest:await wholeHash(JSON.stringify(body))};
  const raw=JSON.stringify(file);if(!await validateSyncOriginalsFile(JSON.parse(raw)))throw new Error('救出原本の内容を検証できません。');
  const saved=await saveBackupOriginals(raw);await current();return saved;
}
