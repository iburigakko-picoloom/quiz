const KEY='userEditGenerationV1';
const queued=new WeakSet<IDBTransaction>();
/** One durable generation per transaction with an actual user-data change.
 * Pull, acknowledgements, media uploads and chunk preparation never call this. */
export function queueUserEditGeneration(tx:IDBTransaction):void{
  if(queued.has(tx))return;queued.add(tx);
  const meta=tx.objectStore('appRecordMeta'),previous=meta.get(KEY);
  previous.onsuccess=()=>{
    const value=previous.result??0;
    if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER){tx.abort();return;}
    try{meta.put(value+1,KEY)}catch{tx.abort()}
  };
}
export async function readUserEditGeneration(db:IDBDatabase):Promise<number>{
  const tx=db.transaction('appRecordMeta'),request=tx.objectStore('appRecordMeta').get(KEY);
  await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});
  const value=request.result??0;
  if(!Number.isSafeInteger(value)||value<0)throw new Error('端末の編集世代を確認できません。端末データを保持しています。');
  return value;
}
