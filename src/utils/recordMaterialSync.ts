import type { AppOutboxOperation, AppRecord } from './appRecordStorage';
import { materialFileEntry } from './materialModel';
import { prepareMaterialUpload, type MaterialTransport } from './materialCloud';

function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('PDFの参照を保存できませんでした。'));}); }

/** Make PDF metadata small before freezing a record batch. The original bytes
 * remain in categoryNotes as a durable local cache. A failed upload changes no
 * record or Outbox operation, and a retry reuses the content-addressed object.
 */
export async function prepareRecordMaterialOutbox(db: IDBDatabase, transport: MaterialTransport, assertCurrent: ()=>Promise<void>, limit=20): Promise<{prepared:number;more:boolean}> {
  let prepared=0;
  for(;prepared<limit;prepared++){
    const tx=db.transaction('appOutbox','readonly');const completion=done(tx);
    const cursor=tx.objectStore('appOutbox').openCursor();
    let candidate:AppOutboxOperation|undefined;
    cursor.onsuccess=()=>{
      const current=cursor.result;if(!current)return;
      const op=current.value as AppOutboxOperation;
      if(op.collection==='indexedDbNotes'&&typeof op.raw==='string'&&materialFileEntry(op.id,op.raw)?.kind==='quiz-material-file') candidate=op;
      else current.continue();
    };
    await completion;
    if(!candidate)return {prepared,more:false};
    await assertCurrent();
    const source=candidate;
    const payload=await prepareMaterialUpload({version:1,updatedAt:'',localStorage:{},indexedDbNotes:{[source.id]:source.raw!}},transport);
    const remote=payload.indexedDbNotes?.[source.id];
    if(!remote||materialFileEntry(source.id,remote)?.kind!=='quiz-material-remote-file')throw new Error('PDFのクラウド参照を確認できませんでした。');
    await assertCurrent();
    const change=db.transaction(['appRecords','appOutbox'],'readwrite');const changed=done(change);
    const currentOp=change.objectStore('appOutbox').get(source.key);
    const currentRow=change.objectStore('appRecords').get(source.key);
    currentRow.onsuccess=()=>{
      const operation=currentOp.result as AppOutboxOperation|undefined;
      const row=currentRow.result as AppRecord|undefined;
      if(!operation||operation.operationId!==source.operationId||operation.raw!==source.raw||row?.raw!==source.raw){change.abort();return;}
      change.objectStore('appOutbox').put({...operation,raw:remote},source.key);
      change.objectStore('appRecords').put({...row,raw:remote},source.key);
    };
    await changed;
  }
  return {prepared,more:true};
}
