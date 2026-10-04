import { appRecordKey, type AppRecord, type AppOutboxOperation, type AppRecordState, type RecordCollection } from './appRecordStorage';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import type { RecordSyncConnection } from './recordSyncOutbox';
import { RecordSyncLocalChangedError } from './recordSyncOutbox';
import { SyncInterruptedError } from './syncInterruption';
import { MAX_RECORD_BATCH_BYTES } from './recordSyncSize';
import {
  chunkFailure, chunkIds, encodeRecordChunks, isChunkInternal, parseChunkManifest,
  RECORD_CHUNK_GUARD_ID, RECORD_CHUNK_GUARD_RAW, restoreRecordChunks,
} from './recordChunkFormat';
const STORES = ['appRecordMeta','appRecords','appOutbox','appRecordBackups'];
const done = (tx: IDBTransaction) => new Promise<void>((resolve,reject) => {
  tx.oncomplete=()=>resolve(); tx.onabort=()=>reject(tx.error ?? chunkFailure());
});
function assertBinding(binding: RecordSyncConnection | undefined, connection: RecordSyncConnection) {
  if (!binding || binding.project!==connection.project || binding.userId!==connection.userId || binding.syncId!==connection.syncId) {
    throw new SyncInterruptedError('connection_changed','読込中に同期先が変わりました。');
  }
}
async function collectGarbage(db: IDBDatabase, connection: RecordSyncConnection): Promise<void> {
  const tx=db.transaction(STORES,'readwrite'),completion=done(tx);
  let failure: unknown;
  const meta=tx.objectStore('appRecordMeta'),binding=meta.get('recordSyncConnection'),frozen=meta.get('pushBatch');
  frozen.onsuccess=()=>{
    try {
      assertBinding(binding.result,connection); if (frozen.result) return;
      const cursor=meta.openCursor(IDBKeyRange.bound('chunkGc:','chunkGc:\uffff'));
      cursor.onsuccess=()=>{
        try {
          const current=cursor.result;if(!current)return;
          const {parentKey,ids}=current.value as {parentKey:string;ids:string[]};
          const parent=tx.objectStore('appRecords').get(parentKey),pending=tx.objectStore('appOutbox').get(parentKey);
          pending.onsuccess=()=>{
            try {
              const row=parent.result as AppRecord|undefined;
              if(!pending.result&&row&&row.serverRevision>0){
                const active=parseChunkManifest(row.raw,row.collection,row.id);
                if(!active||!chunkIds(active).some(id=>ids.includes(id))) {
                  ids.forEach(id=>queueAuxiliaryRecordWrite(tx,'localStorage',id,null));
                }
                meta.delete(current.key);
              }
              current.continue();
            }catch(error){failure=error;tx.abort()}
          };
        }catch(error){failure=error;tx.abort()}
      };
    }catch(error){failure=error;tx.abort()}
  };
  try{await completion}catch(error){throw failure??error}
}
/** Never rewrite a frozen uncertain request. Encoding finishes outside the write
 * transaction, then an exact operation/connection check commits all parts together. */
export async function prepareRecordChunks(db: IDBDatabase, connection: RecordSyncConnection): Promise<void> {
  await collectGarbage(db,connection);
  const read=db.transaction(['appRecordMeta','appOutbox'],'readonly'),complete=done(read);
  const binding=read.objectStore('appRecordMeta').get('recordSyncConnection'),frozen=read.objectStore('appRecordMeta').get('pushBatch');
  const sources:AppOutboxOperation[]=[];
  let failure:unknown;
  frozen.onsuccess=()=>{
    try{
      assertBinding(binding.result,connection);if(frozen.result)return;
      const cursor=read.objectStore('appOutbox').openCursor();
      cursor.onsuccess=()=>{
        try{
          const current=cursor.result;if(!current)return;
          const op=current.value as AppOutboxOperation;
          if(op.raw!==null&&!isChunkInternal(op.collection,op.id)&&['localStorage','indexedDbNotes'].includes(op.collection)){
            const manifest=parseChunkManifest(op.raw,op.collection,op.id);
            if(manifest)sources.push(op);
            else if(op.raw.length>128*1024){
              const {baseContent:_base,...wire}=op;
              if(new TextEncoder().encode(JSON.stringify(wire)).byteLength+3>MAX_RECORD_BATCH_BYTES)sources.push(op);
            }
          }
          current.continue();
        }catch(error){failure=error;read.abort()}
      };
    }catch(error){failure=error;read.abort()}
  };
  try{await complete}catch(error){throw failure??error}
  let changedDuringPreparation=false;
  for(const source of sources){
    const get=db.transaction('appRecords','readonly'),got=done(get),request=get.objectStore('appRecords').get(source.key);
    await got;
    const row=request.result as AppRecord|undefined;
    if(!row||row.raw!==source.raw){changedDuringPreparation=true;continue}
    const manifest=parseChunkManifest(source.raw,source.collection,source.id),raw=manifest?row.logicalRaw:source.raw;
    if(typeof raw!=='string')throw chunkFailure();
    const encoded=await encodeRecordChunks(source.collection as 'localStorage'|'indexedDbNotes',source.id,raw);
    if(manifest&&manifest.version!==encoded.manifest.version)throw chunkFailure();
    const tx=db.transaction(STORES,'readwrite'),completion=done(tx),meta=tx.objectStore('appRecordMeta');
    let writeFailure:unknown;
    const state=meta.get('state'),owner=meta.get('recordSyncConnection'),batch=meta.get('pushBatch');
    const pending=tx.objectStore('appOutbox').get(source.key),current=tx.objectStore('appRecords').get(source.key);
    const guard=tx.objectStore('appRecords').get(appRecordKey('localStorage',RECORD_CHUNK_GUARD_ID));
    const parts=encoded.parts.map(part=>tx.objectStore('appRecords').get(appRecordKey('localStorage',part.id)));
    const last=parts[parts.length-1]!;
    last.onsuccess=()=>{
      try{
        assertBinding(owner.result,connection);
        const op=pending.result as AppOutboxOperation|undefined,existing=current.result as AppRecord|undefined,saved=state.result as AppRecordState|undefined;
        if(batch.result||!saved||!op||op.operationId!==source.operationId||op.raw!==source.raw||op.baseRevision!==source.baseRevision||existing?.raw!==source.raw){changedDuringPreparation=true;return}
        if(guard.result?.raw!==RECORD_CHUNK_GUARD_RAW)queueAuxiliaryRecordWrite(tx,'localStorage',RECORD_CHUNK_GUARD_ID,RECORD_CHUNK_GUARD_RAW);
        encoded.parts.forEach((part,index)=>{if(parts[index].result?.raw!==part.raw)queueAuxiliaryRecordWrite(tx,'localStorage',part.id,part.raw)});
        if(existing.raw!==encoded.raw||existing.logicalRaw!==raw){
          tx.objectStore('appRecords').put({...existing,raw:encoded.raw,logicalRaw:raw},source.key);
          tx.objectStore('appOutbox').put({...op,raw:encoded.raw},source.key);
          meta.put({...saved,revision:saved.revision+1,commitId:crypto.randomUUID()},'state');
        }
      }catch(error){writeFailure=error;tx.abort()}
    };
    try{await completion}catch(error){throw writeFailure??error}
  }
  if(changedDuringPreparation)throw new RecordSyncLocalChangedError();
}

/** Hydrate against this connection's staged and stored parts before any live write. */
export async function hydrateChunkChanges<T extends {collection:RecordCollection;id:string;key:string;raw:string|null;revision:number}>(
  db:IDBDatabase,incoming:T[],connection:RecordSyncConnection,
):Promise<Array<T&{logicalRaw?:string}>>{
  const manifests=incoming.flatMap(row=>{const manifest=parseChunkManifest(row.raw,row.collection,row.id);return manifest?[{row,manifest}]:[]});
  if(!manifests.length)return incoming;
  const tx=db.transaction(['appRecords','appRecordMeta'],'readonly'),completion=done(tx);
  const binding=tx.objectStore('appRecordMeta').get('recordSyncConnection');
  const ids=[RECORD_CHUNK_GUARD_ID,...new Set(manifests.flatMap(item=>chunkIds(item.manifest)))];
  const requests=ids.map(id=>tx.objectStore('appRecords').get(appRecordKey('localStorage',id)));
  await completion;assertBinding(binding.result,connection);
  const values=new Map<string,string>();
  requests.forEach((request,index)=>{if(typeof request.result?.raw==='string')values.set(ids[index],request.result.raw)});
  for(const row of incoming)if(isChunkInternal(row.collection,row.id)){if(row.raw===null)values.delete(row.id);else values.set(row.id,row.raw)}
  if(values.get(RECORD_CHUNK_GUARD_ID)!==RECORD_CHUNK_GUARD_RAW)throw chunkFailure();
  const decoded=new Map<string,string>();
  for(const {row,manifest} of manifests)decoded.set(row.key,await restoreRecordChunks(manifest,values));
  return incoming.map(row=>decoded.has(row.key)?{...row,logicalRaw:decoded.get(row.key)!}:row);
}
