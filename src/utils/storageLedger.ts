import { storedValueBytes } from './storageBreakdown';
import { idbDone, idbResult } from './blobVault';

type Total={bytes:number;count:number;complete?:boolean;after?:IDBValidKey};
type Summary=Record<string,Total>;
const installed=new WeakSet<IDBDatabase>();
/** Account payload accounting commits with the actual write. It reads only
 * small ledger entries, never the old PDF/body, on the ordinary save path. */
export function installStorageLedger(db:IDBDatabase):void{
  if(installed.has(db)||!db.objectStoreNames.contains('storageLedger'))return;installed.add(db);
  const transaction=db.transaction.bind(db);
  db.transaction=((names:string|string[],mode?:IDBTransactionMode,options?:IDBTransactionOptions)=>{
    const list=typeof names==='string'?[names]:Array.from(names);
    if(mode!=='readwrite'||list.every(name=>name==='storageLedger'))return transaction(names,mode,options);
    const tx=transaction([...new Set([...list,'storageLedger'])],mode,options),objectStore=tx.objectStore.bind(tx),ledger=objectStore('storageLedger');
    const summaryRequest=ledger.get('summary');let summary:Summary={};summaryRequest.onsuccess=()=>{summary=summaryRequest.result??{};};
    const cache=new Map<string,number|undefined>(),wrapped=new Map<string,IDBObjectStore>();
    const account=(name:string,key:IDBValidKey,bytes:number|undefined)=>{
      const id=JSON.stringify([name,key]),old=ledger.get(id);
      old.onsuccess=()=>{
        const before=cache.has(id)?cache.get(id):old.result as number|undefined;
        const total=summary[name]??{bytes:0,count:0};
        summary[name]={...total,bytes:Math.max(0,total.bytes+(bytes??0)-(before??0)),count:Math.max(0,total.count+Number(bytes!==undefined)-Number(before!==undefined))};
        cache.set(id,bytes);if(bytes===undefined)ledger.delete(id);else ledger.put(bytes,id);ledger.put(summary,'summary');
      };
    };
    tx.objectStore=((name:string)=>{
      if(name==='storageLedger')return ledger;
      if(wrapped.has(name))return wrapped.get(name)!;
      const store=objectStore(name),put=store.put.bind(store),add=store.add.bind(store),remove=store.delete.bind(store),clear=store.clear.bind(store);
      const write=(fn:typeof put,value:unknown,key?:IDBValidKey)=>{
        const actual=key??(typeof store.keyPath==='string'?(value as Record<string,IDBValidKey>)[store.keyPath]:undefined);
        const bytes=storedValueBytes(value),result=key===undefined?fn(value):fn(value,key);
        if(actual!==undefined)account(name,actual,bytes);return result;
      };
      store.put=((value:unknown,key?:IDBValidKey)=>write(put,value,key)) as typeof store.put;
      store.add=((value:unknown,key?:IDBValidKey)=>write(add,value,key)) as typeof store.add;
      store.delete=((key:IDBValidKey|IDBKeyRange)=>{
        const result=remove(key);
        if(typeof IDBKeyRange!=='undefined'&&key instanceof IDBKeyRange){const r=ledger.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(typeof c.key==='string'&&c.key!=='summary'){const [target,k]=JSON.parse(c.key);if(target===name&&key.includes(k))account(name,k,undefined);}c.continue();};}
        else account(name,key as IDBValidKey,undefined);return result;
      }) as typeof store.delete;
      store.clear=()=>{const result=clear(),r=ledger.getAllKeys();r.onsuccess=()=>{for(const key of r.result)if(typeof key==='string'&&key!=='summary'&&JSON.parse(key)[0]===name){cache.set(key,undefined);ledger.delete(key);}summary[name]={bytes:0,count:0,complete:true};ledger.put(summary,'summary');};return result;};
      wrapped.set(name,store);return store;
    }) as typeof tx.objectStore;
    return tx;
  }) as typeof db.transaction;
}
/** One bounded scan per background pass initializes pre-ledger rows. Later
 * reads use the small summary; edits already accounted for are not recounted. */
export async function initializeStorageLedger(db:IDBDatabase,limit=2000):Promise<boolean>{
  if(!db.objectStoreNames.contains('storageLedger'))return true;
  const read=db.transaction('storageLedger'),readDone=idbDone(read),summary:Summary=(await idbResult(read.objectStore('storageLedger').get('summary')))??{};await readDone;
  const name=Array.from(db.objectStoreNames).find(name=>name!=='storageLedger'&&!summary[name]?.complete);if(!name)return true;
  const tx=db.transaction([name,'storageLedger'],'readwrite'),done=idbDone(tx),ledger=tx.objectStore('storageLedger');
  const fresh=ledger.get('summary');fresh.onsuccess=()=>{
    const totals:Summary=fresh.result??{},total=totals[name]??{bytes:0,count:0};let count=0;
    const cursor=tx.objectStore(name).openCursor(total.after===undefined?undefined:IDBKeyRange.lowerBound(total.after,true));
    cursor.onsuccess=()=>{
      const item=cursor.result;
      if(!item){totals[name]={...total,complete:true};ledger.put(totals,'summary');return;}
      const id=JSON.stringify([name,item.primaryKey]),existing=ledger.get(id),bytes=storedValueBytes(item.value);
      existing.onsuccess=()=>{
        total.bytes+=bytes-(existing.result??0);total.count+=Number(existing.result===undefined);total.after=item.primaryKey;ledger.put(bytes,id);
        if(++count>=limit){totals[name]=total;ledger.put(totals,'summary');}else item.continue();
      };
    };
  };await done;return false;
}
