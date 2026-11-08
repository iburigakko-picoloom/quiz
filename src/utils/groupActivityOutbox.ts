import { accountDatabaseName, assertAccountStorageCurrent, assertAccountNetworkCurrent, type LocalAccountIdentity } from './accountStorage';
import type { StudyActivity } from './groupActivity';

// Device-local delivery state: never mixed into learning sync or another account.
export function activityOutbox(identity: LocalAccountIdentity) {
  const scope = `${identity.project}/${identity.userId}`;
  const open = () => new Promise<IDBDatabase>((resolve,reject)=>{
    assertAccountStorageCurrent(identity);
    const request=indexedDB.open(accountDatabaseName('quiz-make-activity-outbox-v1'),1);
    request.onupgradeneeded=()=>request.result.createObjectStore('events',{keyPath:'key'});
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const transact=async<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore,set:(value:T)=>void)=>void)=>{
    const db=await open();assertAccountStorageCurrent(identity);
    try { return await new Promise<T>((resolve,reject)=>{
      const tx=db.transaction('events',mode);let value:T;
      tx.oncomplete=()=>{try{assertAccountStorageCurrent(identity);resolve(value);}catch(error){reject(error);}};
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('活動を端末に保存できません。'));
      try{operation(tx.objectStore('events'),next=>{value=next;});}catch(error){tx.abort();reject(error);}
    }); } finally {db.close();}
  };
  return {
    put:(events:StudyActivity[])=>transact<void>('readwrite',(store,set)=>{const unique=new Map(events.map(row=>[row.id,row]));for(const row of unique.values()){const key=`${scope}/${row.id}`,request=store.get(key);request.onsuccess=()=>{if(!request.result)store.add({key,scope,row});};}set(undefined);}),
    list:()=>transact<StudyActivity[]>('readonly',(store,set)=>{const r=store.getAll();r.onsuccess=()=>set(r.result.filter(v=>v.scope===scope).map(v=>v.row));}),
    remove:(id:string)=>transact<void>('readwrite',(store,set)=>{store.delete(`${scope}/${id}`);set(undefined);}),
  };
}
const running=new Map<string,Promise<void>>();
export function drainActivityOutbox(identity:LocalAccountIdentity,send:(event:StudyActivity)=>Promise<void>) {
  const key=`${identity.project}/${identity.userId}`;
  if(running.has(key))return running.get(key)!;
  const work=(async()=>{
    const box=activityOutbox(identity);
    for (;;) {
      const batch = await box.list();
      if (!batch.length) break;
      for (const event of batch) {
        assertAccountNetworkCurrent(identity);await send(event);assertAccountStorageCurrent(identity);await box.remove(event.id);
      }
    }
  })().finally(()=>running.delete(key));
  running.set(key,work);return work;
}
