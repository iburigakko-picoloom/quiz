import type { AppOutboxOperation } from './appRecordStorage';
import { commitPreparedRecordMedia } from './recordSyncOutbox';
import { materialFileEntry } from './materialModel';
import { prepareMaterialUpload, type MaterialTransport } from './materialCloud';
import type { SyncProgress } from './syncAttemptStatus';

function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('PDFの参照を保存できませんでした。'));}); }

/** Make PDF metadata small before freezing a record batch. The original bytes
 * remain in categoryNotes as a durable local cache. A failed upload changes no
 * record or Outbox operation, and a retry reuses the content-addressed object.
 */
export async function prepareRecordMaterialOutbox(db: IDBDatabase, transport: MaterialTransport, assertCurrent: ()=>Promise<void>, limit=20,progress?:(value:SyncProgress)=>void): Promise<{prepared:number;more:boolean}> {
  let prepared=0;
  for(;prepared<limit;prepared++){
    const tx=db.transaction(['appOutbox','appRecordMeta'],'readonly');const completion=done(tx);
    const frozen=tx.objectStore('appRecordMeta').get('pushBatch');
    const cursor=tx.objectStore('appOutbox').openCursor();
    let candidate:AppOutboxOperation|undefined;
    cursor.onsuccess=()=>{
      const current=cursor.result;if(!current||frozen.result)return;
      const op=current.value as AppOutboxOperation;
      if(op.collection==='indexedDbNotes'&&typeof op.raw==='string'&&materialFileEntry(op.id,op.raw)?.kind==='quiz-material-file') candidate=op;
      else current.continue();
    };
    await completion;
    if(frozen.result)return {prepared,more:false};
    if(!candidate)return {prepared,more:false};
    await assertCurrent();
    const source=candidate;
    const payload=await prepareMaterialUpload({version:1,updatedAt:'',localStorage:{},indexedDbNotes:{[source.id]:source.raw!}},transport);
    const remote=payload.indexedDbNotes?.[source.id];
    if(!remote||materialFileEntry(source.id,remote)?.kind!=='quiz-material-remote-file')throw new Error('PDFのクラウド参照を確認できませんでした。');
    await assertCurrent();
    await commitPreparedRecordMedia(db,source,remote);
    try{progress?.({label:'資料を送信中',completed:prepared+1,total:null,stage:'preparing'});}catch{/* Informational only. */}
  }
  return {prepared,more:true};
}
