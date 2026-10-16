import { openAppDb } from '../storage';
import { getAccountStorageSession } from './accountStorage';
import { appRecordKey, type AppRecord } from './appRecordStorage';

/** A projection repair is not an edit: keep the exact committed/local record,
 * its timestamp, revision and operation ID. Never consult backup timestamps. */
export async function reconstructCanonicalNote(key:string,isValid:(raw:string)=>boolean,repair=true):Promise<string|null|undefined>{
  const owner=getAccountStorageSession(),native=globalThis.localStorage,db=await openAppDb();
  const current=()=>{if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('ノートのアカウントが変わりました。');owner?.assertCurrent();};
  current();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['appRecords','categoryNotes','appDataBackups'],repair?'readwrite':'readonly');
    const record=tx.objectStore('appRecords').get(appRecordKey('indexedDbNotes',key));
    const projection=tx.objectStore('categoryNotes').get(key);
    let result:string|null|undefined;
    projection.onsuccess=()=>{
      try {
        current();
        const row=record.result as AppRecord|undefined;
        if(!row||row.collection!=='indexedDbNotes'||row.id!==key||row.key!==appRecordKey('indexedDbNotes',key))return;
        if(row.raw===null)result=null;
        else {
          const raw=row.logicalRaw??row.raw;
          if(typeof raw!=='string'||!isValid(raw))return;
          result=raw;
        }
        if(!repair)return;
        if(projection.result!==undefined&&projection.result!==result){
          // Preserve an inconsistent projection before replacing it. This key
          // is outside automatic retention and is never sent as an edit.
          tx.objectStore('appDataBackups').add(projection.result,`note-rescue:${key}:${crypto.randomUUID()}`);
        }
        if(result===null)tx.objectStore('categoryNotes').delete(key);
        else tx.objectStore('categoryNotes').put(result,key);
      }catch{tx.abort();}
    };
    tx.oncomplete=()=>{try{current();resolve(result);}catch(error){reject(error);}};
    tx.onabort=()=>reject(tx.error??new Error('ノートの正規レコードを再構築できません。原本は保持しています。'));
  });
}
