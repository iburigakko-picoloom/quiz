import { accountDatabaseName, getAccountStorageSession } from './accountStorage';
export interface StorageBreakdownRow { label: string; bytes: number; count: number; partial?: boolean }
// Payload size, not physical disk allocation: IDB overhead/compression and
// browser caches are intentionally not represented by this sum.
export function storedValueBytes(value: unknown): number {
  if (typeof value === 'string') {
    let bytes=0;
    for(let i=0;i<value.length;i++){
      const c=value.charCodeAt(i);
      if(c<128)bytes++;else if(c<2048)bytes+=2;
      else if(c>=0xd800&&c<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}
      else bytes+=3;
    }
    return bytes;
  }
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum,[key,item]) => sum + storedValueBytes(key) + storedValueBytes(item),0);
}
const labels: Record<string,string> = {
  categoryNotes:'現在のPDF・ノート', categoryNoteBackups:'PDF・ノートの直前コピー',
  appRecords:'同期用の現在データ', appRecordBackups:'同期用の直前コピー',
  appOutbox:'未送信データ', appDataBackups:'復旧・移行用コピー',
  questionImageBlobs:'問題画像', backups:'保存したバックアップ',
  appPullStage:'受信中のデータ', appPullMedia:'受信画像', appRecordMeta:'同期管理・送信準備',
  contentBlobs:'PDF・画像・本文の共通保管庫',contentBlobMeta:'本文の管理情報',contentBlobRefs:'本文の参照一覧',contentBlobJobs:'本文の送信待ち',recordHistory:'項目ごとの復旧履歴',deltaStage:'引き継ぎ中のデータ',
};
export async function readStorageBreakdown(options: {signal?: AbortSignal; onProgress?: (rows: StorageBreakdownRow[], label: string) => void} = {}): Promise<StorageBreakdownRow[]> {
  if (!indexedDB.databases) throw new Error('このブラウザでは保存先の一覧を取得できません。');
  const owner=getAccountStorageSession();
  const current=()=>{options.signal?.throwIfAborted();if(owner!==getAccountStorageSession())throw new Error('アカウントが変わりました。再確認してください。');owner?.assertCurrent();};
  current();
  const names=new Map(['quiz-make-app-data-v1','quiz-make-notes-v1','quiz-make-backups'].map(base=>[accountDatabaseName(base),base]));
  const existing=await boundedRead(indexedDB.databases(),options.signal);current();
  const rows:StorageBreakdownRow[]=[];
  for(const entry of existing){
    if(!entry.name||!names.has(entry.name))continue;
    const base=names.get(entry.name)!;
    let accepting=true;
    const opening=new Promise<IDBDatabase>((resolve,reject)=>{
      let blocked=false;
      const req=indexedDB.open(entry.name!,entry.version);
      // Never create a database that disappeared after enumeration.
      req.onupgradeneeded=()=>req.transaction?.abort();
      req.onsuccess=()=>{if(blocked||!accepting)req.result.close();else resolve(req.result);};req.onerror=()=>reject(req.error);
      req.onblocked=()=>{blocked=true;reject(new Error('別の画面が保存領域を更新中です。'));};
    });
    const db=await boundedRead(opening,options.signal).catch(error=>{accepting=false;throw error;});
    try{
      current();db.onversionchange=()=>db.close();
      if(base==='quiz-make-app-data-v1'&&db.objectStoreNames.contains('storageLedger')){
        const totals=await new Promise<Record<string,{bytes:number;count:number;complete?:boolean}>>((resolve,reject)=>{const tx=db.transaction('storageLedger'),r=tx.objectStore('storageLedger').get('summary');tx.oncomplete=()=>resolve(r.result??{});tx.onabort=()=>reject(tx.error);});
        for(const store of Array.from(db.objectStoreNames).filter(name=>name!=='storageLedger')){
          const total=totals[store];if(total?.count||!total?.complete)rows.push({label:labels[store]??store,bytes:total?.bytes??0,count:total?.count??0,...(!total?.complete?{partial:true}:{})});
        }
        options.onProgress?.([...rows],'');continue;
      }
      if(base==='quiz-make-backups'&&db.objectStoreNames.contains('backups')){
        const tx=db.transaction('backups');
        if(tx.objectStore('backups').indexNames.contains('summary')){
          const row={label:labels.backups,bytes:0,count:0};
          await new Promise<void>((resolve,reject)=>{const r=tx.objectStore('backups').index('summary').openKeyCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;row.bytes+=(c.key as [string,string,string,number])[3];row.count++;c.continue();};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
          if(row.count)rows.push(row);options.onProgress?.([...rows],'');continue;
        }
      }
      for(const store of Array.from(db.objectStoreNames)){
        const row={label:(base==='quiz-make-notes-v1'?'移行前の保存領域：':'')+(labels[store]??store),bytes:0,count:0};
        let updated=0;
        const progress=()=>{options.onProgress?.([...rows,{...row}],row.label);updated=Date.now();};
        progress();
        await new Promise<void>((resolve,reject)=>{
          const tx=db.transaction(store,'readonly'),req=tx.objectStore(store).openCursor();
          const stop=()=>{try{tx.abort();}catch{};finish(new Error('集計を中止しました。途中までの結果を表示しています。'));};
          const timer=setTimeout(()=>{try{tx.abort();}catch{};finish(new Error('読み取りに時間がかかっています。途中までの結果を表示しています。'));},30000);
          const finish=(error?:Error)=>{clearTimeout(timer);options.signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve();};
          options.signal?.addEventListener('abort',stop,{once:true});
          tx.oncomplete=()=>finish();tx.onabort=()=>finish(tx.error??new Error('保存容量を読み取れません。'));
          req.onsuccess=()=>{try{current();const cursor=req.result;if(!cursor)return;row.count++;row.bytes+=storedValueBytes(cursor.value);if(Date.now()-updated>250)progress();cursor.continue();}catch{tx.abort();}};
        });
        current();if(row.count)rows.push(row);options.onProgress?.([...rows],'');
      }
    }finally{db.close();}
  }
  return rows.sort((a,b)=>b.bytes-a.bytes);
}

function boundedRead<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const stop=()=>finish(new Error('集計を中止しました。'));
    const timer=setTimeout(()=>finish(new Error('保存領域の応答がありません。再試行してください。')),30000);
    const finish=(error?:Error,value?:T)=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve(value as T);};
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    promise.then(value=>finish(undefined,value),error=>finish(error));
  });
}
