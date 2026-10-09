import {accountDatabaseName,assertAccountStorageCurrent,type LocalAccountIdentity} from './accountStorage';
import type {CloudPublishResult} from './cloudService';
import type {PublicationPayload} from './publicationPayload';
import type {PublicationProgress} from './publicationProtocol';
export interface PublicationJob extends PublicationProgress {
  id:string;scope:string;localSetId:string;title:string;digest:string;state:'queued'|'publishing'|'completed'|'failed';createdAt:string;
  error?:string;errorCode?:string;retryable?:boolean;result?:CloudPublishResult;applied?:boolean;warning?:string;groupFolderId?:string;groupId?:string;publicFolderId?:string;publicFolderPath?:import('./sharedFolders').SharedFolderPart[];
}
export interface PublicationRepository {
  list():Promise<PublicationJob[]>;enqueue(jobs:{job:PublicationJob;payload:PublicationPayload}[]):Promise<void>;update(job:PublicationJob):Promise<void>;payload(id:string):Promise<PublicationPayload>;retirePayload(id:string):Promise<void>;
}
const databases=new Map<string,Promise<IDBDatabase>>();
export function publicationScope(identity:LocalAccountIdentity){return `${identity.project}/${identity.userId}`;}
export function publicationRepository(identity:LocalAccountIdentity):PublicationRepository {
  const scope=publicationScope(identity);
  const db=()=>{assertAccountStorageCurrent(identity);const name=accountDatabaseName('quiz-make-publication-jobs-v1');let opened=databases.get(name);if(!opened){opened=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{const headers=request.result.createObjectStore('jobs',{keyPath:'id'});headers.createIndex('scope','scope');request.result.createObjectStore('payloads',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});databases.set(name,opened);opened.catch(()=>databases.delete(name));}return opened;};
  const transact=async<T>(stores:string[],mode:IDBTransactionMode,operation:(tx:IDBTransaction,resolve:(value:T)=>void)=>void)=>{
    const connection=await db();assertAccountStorageCurrent(identity);
    return new Promise<T>((resolve,reject)=>{const tx=connection.transaction(stores,mode);let value:T;tx.oncomplete=()=>{try{assertAccountStorageCurrent(identity);resolve(value);}catch(error){reject(error);}};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('公開状態を端末に保存できません。'));try{operation(tx,result=>{value=result;});}catch(error){tx.abort();reject(error);}});
  };
  return {
    list:()=>transact<PublicationJob[]>(['jobs'],'readonly',(tx,set)=>{const request=tx.objectStore('jobs').index('scope').getAll(scope);request.onsuccess=()=>set(request.result.sort((a:PublicationJob,b:PublicationJob)=>a.createdAt.localeCompare(b.createdAt)));}),
    enqueue:rows=>transact<void>(['jobs','payloads'],'readwrite',(tx,set)=>{for(const {job,payload} of rows){if(job.scope!==scope)throw new Error('公開アカウントが変わりました。');tx.objectStore('jobs').add(job);tx.objectStore('payloads').add({id:job.id,scope,payload});}set(undefined);}),
    update:job=>transact<void>(['jobs'],'readwrite',(tx,set)=>{if(job.scope!==scope)throw new Error('公開アカウントが変わりました。');tx.objectStore('jobs').put(job);set(undefined);}),
    payload:id=>transact<PublicationPayload>(['payloads'],'readonly',(tx,set)=>{const request=tx.objectStore('payloads').get(id);request.onsuccess=()=>{if(request.result?.scope!==scope){tx.abort();return;}set(request.result.payload);};}),
    retirePayload:id=>transact<void>(['payloads'],'readwrite',(tx,set)=>{const store=tx.objectStore('payloads'),request=store.get(id);request.onsuccess=()=>{if(request.result?.scope===scope)store.delete(id);set(undefined);};}),
  };
}
