import { accountDatabaseName, getAccountStorageSession } from './accountStorage';
export interface StorageBreakdownRow { label: string; bytes: number; count: number }
// Payload size, not physical disk allocation: IDB overhead/compression and
// browser caches are intentionally not represented by this sum.
export function storedValueBytes(value: unknown): number {
  if (typeof value === 'string') return new Blob([value]).size;
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum,[key,item]) => sum + new Blob([key]).size + storedValueBytes(item),0);
}
const labels: Record<string,string> = {
  categoryNotes:'現在のPDF・ノート', categoryNoteBackups:'PDF・ノートの直前コピー',
  appRecords:'同期用の現在データ', appRecordBackups:'同期用の直前コピー',
  appOutbox:'未送信データ', appDataBackups:'復旧・移行用コピー',
  questionImageBlobs:'問題画像', backups:'保存したバックアップ',
  appPullStage:'受信中のデータ', appPullMedia:'受信画像', appRecordMeta:'同期管理・送信準備',
};
export async function readStorageBreakdown(): Promise<StorageBreakdownRow[]> {
  if (!indexedDB.databases) throw new Error('このブラウザでは保存先の一覧を取得できません。');
  const owner=getAccountStorageSession();
  const current=()=>{if(owner!==getAccountStorageSession())throw new Error('アカウントが変わりました。再確認してください。');owner?.assertCurrent();};
  current();
  const names=new Map(['quiz-make-app-data-v1','quiz-make-notes-v1','quiz-make-backups'].map(base=>[accountDatabaseName(base),base]));
  const existing=await indexedDB.databases();current();
  const rows:StorageBreakdownRow[]=[];
  for(const entry of existing){
    if(!entry.name||!names.has(entry.name))continue;
    const base=names.get(entry.name)!;
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      let blocked=false;
      const req=indexedDB.open(entry.name!,entry.version);
      // Never create a database that disappeared after enumeration.
      req.onupgradeneeded=()=>req.transaction?.abort();
      req.onsuccess=()=>{if(blocked)req.result.close();else resolve(req.result);};req.onerror=()=>reject(req.error);
      req.onblocked=()=>{blocked=true;reject(new Error('別の画面が保存領域を更新中です。'));};
    });
    try{
      current();db.onversionchange=()=>db.close();
      for(const store of Array.from(db.objectStoreNames)){
        const row={label:(base==='quiz-make-notes-v1'?'移行前の保存領域：':'')+(labels[store]??store),bytes:0,count:0};
        await new Promise<void>((resolve,reject)=>{
          const tx=db.transaction(store,'readonly'),req=tx.objectStore(store).openCursor();
          tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('保存容量を読み取れません。'));
          req.onsuccess=()=>{try{current();const cursor=req.result;if(!cursor)return;row.count++;row.bytes+=storedValueBytes(cursor.value);cursor.continue();}catch{tx.abort();}};
        });
        current();if(row.count)rows.push(row);
      }
    }finally{db.close();}
  }
  return rows.sort((a,b)=>b.bytes-a.bytes);
}
