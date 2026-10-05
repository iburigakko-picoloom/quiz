import { exportAppDataRaw, openAppDb } from '../storage';
import { saveAppRecords } from './appRecordStorage';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import { MAX_LOCAL_QUESTION_IMAGE_BYTES } from './imageLimits';
import type { AppData } from '../types';

export const IMAGE_BLOB_STORE='questionImageBlobs';
export const IMAGE_SYNC_STORES=[IMAGE_BLOB_STORE,'appRecordMeta','appRecords','appRecordBackups','appOutbox'];
const MARKER='questionImageMigrationV1';
const OLD_DB='quiz-make-local-question-images-v1';
const OLD_STORE='images';
export interface StoredQuestionImage { id:string;questionId:string;name:string;type:string;blob:Blob;addedAt:string }
export interface QuestionImageDescriptor { id:string;questionId:string;name:string;type:string;size:number;sha256:string;path?:string;addedAt:string }
function done(tx:IDBTransaction):Promise<void>{return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('画像の保存を完了できませんでした。'));});}
function request<T>(value:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});}
export const questionImageMetadataKey=(id:string)=>`quizMake:image:${id}`;
export function validQuestionImageDescriptor(value:unknown):value is QuestionImageDescriptor{
  if(!value||typeof value!=='object')return false;
  const row=value as QuestionImageDescriptor;
  return typeof row.id==='string'&&!!row.id&&typeof row.questionId==='string'&&!!row.questionId
    && typeof row.name==='string'&&typeof row.type==='string'&&/^image\/(png|jpeg|webp|heic|heif)$/u.test(row.type)
    && Number.isSafeInteger(row.size)&&row.size>0&&row.size<=MAX_LOCAL_QUESTION_IMAGE_BYTES
    && typeof row.sha256==='string'&&/^[0-9a-f]{64}$/u.test(row.sha256)
    && typeof row.addedAt==='string'&&Number.isFinite(Date.parse(row.addedAt))
    && (row.path===undefined||typeof row.path==='string'&&/^[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|jpg|webp|heic|heif)$/u.test(row.path));
}
export async function describeQuestionImage(image:StoredQuestionImage):Promise<QuestionImageDescriptor>{
  if(!image.id||!image.questionId||!/^image\/(png|jpeg|webp|heic|heif)$/u.test(image.type)
    ||image.blob.size===0||image.blob.size>MAX_LOCAL_QUESTION_IMAGE_BYTES)throw new Error('保存済み画像の形式が不正です。');
  const bytes=await image.blob.arrayBuffer();
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {id:image.id,questionId:image.questionId,name:image.name,type:image.type,size:image.blob.size,sha256,addedAt:image.addedAt};
}

let legacyDb:Promise<IDBDatabase>|null=null;
function openLegacy():Promise<IDBDatabase>{
  if(legacyDb)return legacyDb;
  legacyDb=new Promise((resolve,reject)=>{
    const opening=indexedDB.open(accountDatabaseName(OLD_DB),2);let blocked=false;
    opening.onupgradeneeded=()=>{if(!opening.result.objectStoreNames.contains(OLD_STORE))opening.result.createObjectStore(OLD_STORE,{keyPath:'id'});};
    opening.onsuccess=()=>{if(blocked){opening.result.close();return;}opening.result.onversionchange=()=>{opening.result.close();legacyDb=null;};opening.result.onclose=()=>{legacyDb=null;};resolve(opening.result);};
    opening.onerror=()=>reject(opening.error);
    opening.onblocked=()=>{blocked=true;reject(new Error('別のタブが画像の移行を妨げています。'));};
  });
  void legacyDb.catch(()=>{legacyDb=null;});
  return legacyDb;
}

/** Original image DB stays untouched. Blob, small sync descriptor, Outbox and
 * migration marker commit together; a failed quota write can be retried.
 */
export async function openQuestionImageRecordDb():Promise<IDBDatabase>{
  const db=await openAppDb();
  const markerTx=db.transaction('appRecordMeta');const markerDone=done(markerTx);
  const marker=markerTx.objectStore('appRecordMeta').get(MARKER);await markerDone;
  if(marker.result===1)return db;
  const raw=await exportAppDataRaw({coordinationLockHeld:true});
  await saveAppRecords(db,JSON.parse(raw) as AppData,new Date().toISOString(),()=>({raw,savedAt:new Date().toISOString()}));
  const old=await openLegacy();
  const read=old.transaction(OLD_STORE);const readDone=done(read);
  const originals=read.objectStore(OLD_STORE).getAll();await readDone;
  const snapshots:Array<{image:StoredQuestionImage;descriptor:QuestionImageDescriptor}>=[];
  for(const image of originals.result as StoredQuestionImage[])snapshots.push({image,descriptor:await describeQuestionImage(image)});
  const tx=db.transaction(IMAGE_SYNC_STORES,'readwrite');const completed=done(tx);
  const current=tx.objectStore('appRecordMeta').get(MARKER);
  current.onsuccess=()=>{
    if(current.result===1)return;
    for(const {image,descriptor} of snapshots){
      tx.objectStore(IMAGE_BLOB_STORE).put(image,image.id);
      queueAuxiliaryRecordWrite(tx,'questionImages',image.id,JSON.stringify(descriptor));
    }
    tx.objectStore('appRecordMeta').put(1,MARKER);
  };
  await completed;
  return db;
}

export async function saveQuestionImage(image:StoredQuestionImage):Promise<void>{
  const descriptor=await describeQuestionImage(image);
  const db=await openQuestionImageRecordDb();
  const tx=db.transaction(IMAGE_SYNC_STORES,'readwrite');const completed=done(tx);
  tx.objectStore(IMAGE_BLOB_STORE).put(image,image.id);
  queueAuxiliaryRecordWrite(tx,'questionImages',image.id,JSON.stringify(descriptor));
  await completed;
}
export async function readQuestionImages(questionId:string,imageIds:readonly string[]):Promise<StoredQuestionImage[]>{
  if(!imageIds.length)return [];
  const db=await openQuestionImageRecordDb();const tx=db.transaction(IMAGE_BLOB_STORE);const completed=done(tx);
  const requested=imageIds.map(id=>request<StoredQuestionImage|undefined>(tx.objectStore(IMAGE_BLOB_STORE).get(id)));
  const found=await Promise.all(requested);await completed;
  return found.filter((image):image is StoredQuestionImage=>!!image&&image.questionId===questionId);
}
export async function removeQuestionImages(predicate:(image:StoredQuestionImage)=>boolean):Promise<void>{
  const db=await openQuestionImageRecordDb();const tx=db.transaction(IMAGE_SYNC_STORES,'readwrite');const completed=done(tx);
  const cursor=tx.objectStore(IMAGE_BLOB_STORE).openCursor();
  cursor.onsuccess=()=>{const current=cursor.result;if(!current)return;
    const image=current.value as StoredQuestionImage;
    if(predicate(image)){current.delete();queueAuxiliaryRecordWrite(tx,'questionImages',image.id,null);}
    current.continue();
  };
  await completed;
}
import { accountDatabaseName } from './accountStorage';
