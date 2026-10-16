import { accountLocalStorage as localStorage, accountDatabaseName, getAccountStorageSession } from './accountStorage';
import type { SyncPayload } from './syncService';
import type { FileBackup } from './backupPayload';
import { hashBackupBlob, jsonBackupBlob } from './incrementalJsonDigest';
import { idbDone, packBlobNote, parseBlobNote, queueBlobReferences, readMeta, unpackBlobNote, writeMeta } from './blobVault';

export interface SavedBackup { id: string; createdAt: string; kind: 'manual' | 'before-import' | 'before-sync' | 'before-logout'; raw: string; byteSize?: number; legacyOriginalRaw?: string; format?: 'originals'|'partial'; contentDigest?: string; retentionState?: 'pending' | 'ready'; }
export type SavedBackupSummary = Omit<SavedBackup, 'raw' | 'byteSize' | 'legacyOriginalRaw'> & { byteSize: number };
type StoredBackup=Omit<SavedBackup,'raw'>&{raw:string|Blob;verification?:{digest:string;complete:boolean};blobVault?:true};
export interface SavedBackupReference { id:string; digest:string; byteSize:number; complete:boolean }
export function summarizeSavedBackup(record: SavedBackup): SavedBackupSummary {
  return { id: record.id, createdAt: record.createdAt, kind: record.kind,
    ...(record.format ? {format:record.format} : {}),
    ...(record.contentDigest ? {contentDigest:record.contentDigest,retentionState:record.retentionState} : {}),
    byteSize: typeof record.byteSize === 'number' && Number.isFinite(record.byteSize) && record.byteSize >= 0 ? record.byteSize : new Blob([record.raw]).size };
}
const DB = 'quiz-make-backups';
// Durable backups must not be matched by legacy temporary-backup cleanup.
const PREFIX = 'quizMake:sync:saved-backup:';
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const owner = getAccountStorageSession(); let blocked = false;
    const request = indexedDB.open(accountDatabaseName(DB), 3);
    request.onupgradeneeded = () => {
      const store=request.result.objectStoreNames.contains('backups')?request.transaction!.objectStore('backups'):request.result.createObjectStore('backups', { keyPath: 'id' });
      // IndexedDB builds these indexes without cloning old backup bodies into JS.
      if (!store.indexNames.contains('summary')) store.createIndex('summary',['createdAt','id','kind','byteSize']);
      if (!store.indexNames.contains('format')) store.createIndex('format',['id','format']);
      if (!store.indexNames.contains('retention')) store.createIndex('retention',['id','contentDigest','retentionState']);
      if (!request.result.objectStoreNames.contains('retentionStates')) request.result.createObjectStore('retentionStates');
    };
    request.onsuccess = () => { try { if (blocked) { request.result.close(); return; } if (owner !== getAccountStorageSession()) throw new Error('バックアップの保存先が変わりました。'); owner?.assertCurrent(); request.result.onversionchange = () => request.result.close(); resolve(request.result); } catch (error) { request.result.close(); reject(error); } };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('バックアップ保存領域を開けません。別のタブを閉じて再試行してください。')); };
  });
}
/** Move one old backup at a time, retaining its exact serialized original. */
export async function migrateSavedBackups(): Promise<{ moved: number; retained: number }> {
  const result = { moved: 0, retained: 0 }; if (typeof indexedDB === 'undefined') return result;
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const current = () => { if (owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('バックアップ移行中にアカウントが変わりました。原本は保持しています。'); owner?.assertCurrent(); };
  const keys: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(PREFIX)) keys.push(key); }
  for (const key of keys) {
    current(); const original = localStorage.getItem(key); if (original === null) continue;
    let record: SavedBackup;
    try {
      record = JSON.parse(original);
      if (!record || key !== PREFIX + record.id || typeof record.raw !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || !['manual', 'before-import', 'before-sync', 'before-logout'].includes(record.kind)) throw new Error('Invalid backup');
    } catch { result.retained++; continue; }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(original)))].map(n => n.toString(16).padStart(2, '0')).join('');
    const db = await database();
    try {
      current();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite'), store = tx.objectStore('backups'), old = store.get(record.id); let failure: unknown;
        old.onsuccess = () => { try {
          current(); const id = old.result && (old.result.raw !== record.raw || old.result.createdAt !== record.createdAt || old.result.kind !== record.kind || old.result.legacyOriginalRaw && old.result.legacyOriginalRaw !== original) ? record.id + '-legacy-' + digest : record.id;
          record = { ...record, id, byteSize: new Blob([record.raw]).size, legacyOriginalRaw: original };
          const existing = store.get(id); existing.onsuccess = () => { try { current(); if (existing.result && existing.result.raw !== record.raw) throw new Error('保管済みバックアップが異なります。'); store.put(record); } catch (error) { failure = error; tx.abort(); } };
        } catch (error) { failure = error; tx.abort(); } };
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('旧バックアップを保存できません。'));
      });
      const stored = await new Promise<SavedBackup>((resolve, reject) => { const tx = db.transaction('backups'), request = tx.objectStore('backups').get(record.id); tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); });
      current(); if (stored?.raw !== record.raw || stored.legacyOriginalRaw !== original) throw new Error('旧バックアップの読み戻しを確認できません。原本は保持しています。');
      if (localStorage.getItem(key) === original) { try { localStorage.removeItem(key); } catch { /* Retry verified cleanup on the next call. */ } }
      if (localStorage.getItem(key) === null) result.moved++; else result.retained++;
    } finally { db.close(); }
  }
  return result;
}
async function operation<T>(mode: IDBTransactionMode, execute: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('backups', mode);
    const request = execute(transaction.objectStore('backups'));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('バックアップを保存できませんでした。')); };
  });
}
async function storeBackup(record: SavedBackup): Promise<void> {
  const db=await (await import('../storage')).openAppDb();
  if(!await readMeta(db,'deltaEnabled')){await operation('readwrite',store=>store.add(record));return;}
  const raw=await packBlobNote(db,record.raw), blob=new Blob([raw],{type:'application/json'});
  const tx=db.transaction('contentBlobRefs','readwrite'),done=idbDone(tx);queueBlobReferences(tx,`backup:${record.id}`,raw);await done;
  await operation('readwrite',store=>store.add({...record,raw:blob,byteSize:blob.size,blobVault:true}));
}
export async function saveBackupPayload(payload: SyncPayload, kind: SavedBackup['kind']): Promise<SavedBackup & {cleanupWarning?: string}> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const current = () => { if(owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('バックアップの保存先が変わりました。原本は保持しています。'); owner?.assertCurrent(); };
  current();
  const record: SavedBackup = { id: `backup-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), kind, raw: JSON.stringify(payload) };
  if('backupManifest' in payload&&(payload.backupManifest as {completeness?:string})?.completeness==='partial')record.format='partial';
  record.byteSize = new Blob([record.raw]).size;
  if (typeof indexedDB === 'undefined') localStorage.setItem(PREFIX + record.id, JSON.stringify(record));
  else await storeBackup(record);
  const checked = await getSavedBackup(record.id);
  current();
  if (!checked || checked.raw !== record.raw) throw new Error('バックアップの読み戻しを確認できませんでした。');
  if ('backupManifest' in payload && (payload.backupManifest as {completeness?:string})?.completeness === 'complete') {
    try {
      const {pruneBackupHistoryAfterSave} = await import('./backupHistory');
      await pruneBackupHistoryAfterSave(record.id, record.raw, current);
    } catch { return {...record,cleanupWarning:'新しいバックアップは保存しましたが、古い分の整理を完了できませんでした。残ったコピーは保持しています。'}; }
  }
  return record;
}
/** Rescue originals may contain broken graph references. They are stored as
 * originals, never relabelled as a complete directly restorable backup. */
export async function saveBackupOriginals(raw: string): Promise<SavedBackup> {
  const owner=getAccountStorageSession(),native=globalThis.localStorage;
  const current=()=>{if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('原本のアカウントが変わりました。');owner?.assertCurrent();};
  current();
  const record:SavedBackup={id:`backup-${crypto.randomUUID()}`,createdAt:new Date().toISOString(),kind:'before-sync',format:'originals',raw,byteSize:new Blob([raw]).size};
  if(typeof indexedDB==='undefined')localStorage.setItem(PREFIX+record.id,JSON.stringify(record));
  else await storeBackup(record);
  current();const saved=await getSavedBackup(record.id);current();
  if(saved?.raw!==raw)throw new Error('救出原本の読み戻しを確認できません。');
  return record;
}
/** Sync needs a durable witness, not another in-memory copy of all PDFs/images. */
export async function saveBackupPayloadReference(payload:FileBackup,kind:SavedBackup['kind']):Promise<SavedBackupReference>{
  const owner=getAccountStorageSession(),native=globalThis.localStorage;
  const current=()=>{if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('バックアップの保存先が変わりました。');owner?.assertCurrent();};
  current();
  const snapshot:FileBackup={...payload,localStorage:{...payload.localStorage},indexedDbNotes:{...payload.indexedDbNotes},backupManifest:{...payload.backupManifest,issues:[...payload.backupManifest.issues]},questionImageFiles:payload.questionImageFiles.map(file=>({descriptor:{...file.descriptor},dataUrl:file.dataUrl}))};
  const {validateFileBackup}=await import('./backupPayload');
  const checked=await validateFileBackup(snapshot,{retainImages:false});
  if(!checked.ok)throw new Error(checked.error);
  if(kind==='before-sync'&&snapshot.backupManifest.completeness==='complete'){
    const prior=(await listSavedBackups()).find(row=>row.kind===kind&&!row.format&&row.contentDigest===snapshot.backupManifest.contentDigest);
    if(prior){
      const stored=await operation<StoredBackup|undefined>('readonly',store=>store.get(prior.id));current();
      if(stored?.verification?.complete&&stored.byteSize!==undefined){
        const reference={id:stored.id,digest:stored.verification.digest,byteSize:stored.byteSize,complete:true};
        // Pin before returning an existing witness to an in-progress operation.
        const db=await database();
        try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('retentionStates','readwrite');tx.objectStore('retentionStates').delete(stored.id);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
        current();if(await verifySavedBackupReference(reference)){current();return reference;}
      }
    }
  }
  const appDb = await (await import('../storage')).openAppDb();
  const packed = await readMeta(appDb,'deltaEnabled') ? await packBlobNote(appDb,JSON.stringify(snapshot),'remote') : undefined;
  const {blob,digest}=await jsonBackupBlob(packed?JSON.parse(packed):snapshot);current();
  const record:StoredBackup={id:`backup-${crypto.randomUUID()}`,createdAt:new Date().toISOString(),kind,raw:blob,byteSize:blob.size,...(packed?{blobVault:true as const}:{}),verification:{digest,complete:snapshot.backupManifest.completeness==='complete'},...(snapshot.backupManifest.completeness==='partial'?{format:'partial' as const}:{contentDigest:snapshot.backupManifest.contentDigest,retentionState:'pending' as const})};
  if(packed){const tx=appDb.transaction('contentBlobRefs','readwrite'),done=idbDone(tx);queueBlobReferences(tx,`backup:${record.id}`,packed);await done;}
  await operation('readwrite',store=>store.add(record));current();
  const reference:SavedBackupReference={id:record.id,digest,byteSize:blob.size,complete:snapshot.backupManifest.completeness==='complete'};
  if(!await verifySavedBackupReference(reference))throw new Error('バックアップの読み戻しを確認できませんでした。');current();
  if(reference.complete){
    const {pruneVerifiedBackupHistory}=await import('./backupHistory');
    await pruneVerifiedBackupHistory(reference.id,current).catch(()=>{/* Retain all copies if cleanup fails. */});
  }
  return reference;
}
export async function verifySavedBackupReference(reference:SavedBackupReference):Promise<boolean>{
  const owner=getAccountStorageSession(),native=globalThis.localStorage;
  const record=await operation<StoredBackup|undefined>('readonly',store=>store.get(reference.id));
  const blob=typeof record?.raw==='string'?new Blob([record.raw]):record?.raw;
  const matches=Boolean(record?.verification?.digest===reference.digest&&record.verification.complete===reference.complete&&blob&&blob.size===reference.byteSize&&await hashBackupBlob(blob)===reference.digest);
  if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('バックアップの保存先が変わりました。');owner?.assertCurrent();
  return matches;
}
export async function getSavedBackup(id: string): Promise<SavedBackup | undefined> {
  if (typeof indexedDB !== 'undefined') {
    await migrateSavedBackups().catch(() => undefined);
    const owner=getAccountStorageSession(),native=globalThis.localStorage;
    const stored = await operation<StoredBackup | undefined>('readonly', (store) => store.get(id));
    if (stored) {
      let raw=typeof stored.raw==='string'?stored.raw:await stored.raw.text();
      if (parseBlobNote(raw)) raw = await unpackBlobNote(await (await import('../storage')).openAppDb(), raw);
      let legacyOriginalRaw = stored.legacyOriginalRaw;
      if (legacyOriginalRaw && parseBlobNote(legacyOriginalRaw)) legacyOriginalRaw = await unpackBlobNote(await (await import('../storage')).openAppDb(), legacyOriginalRaw);
      if(owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('バックアップの保存先が変わりました。');owner?.assertCurrent();
      return {...stored,raw,...(legacyOriginalRaw ? { legacyOriginalRaw } : {})};
    }
  }
  const raw = localStorage.getItem(PREFIX + id);
  return raw ? JSON.parse(raw) as SavedBackup : undefined;
}
export async function listSavedBackups(): Promise<SavedBackupSummary[]> {
  const records: SavedBackupSummary[] = [];
  if (typeof indexedDB !== 'undefined') {
    await migrateSavedBackups().catch(() => undefined);
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['backups','retentionStates'], 'readonly');
      const store=transaction.objectStore('backups'),seen=new Set<string>(),formats=new Map<string,SavedBackup['format']>();
      const retention=new Map<string,Pick<SavedBackup,'contentDigest'|'retentionState'>>();
      const metadata=store.index('retention').openKeyCursor();
      metadata.onsuccess=()=>{const cursor=metadata.result;if(!cursor)return;const [id,contentDigest,retentionState]=cursor.key as string[];retention.set(id,{contentDigest,retentionState:retentionState as SavedBackup['retentionState']});cursor.continue();};
      const settled=new Set<string>(),states=transaction.objectStore('retentionStates').openCursor();
      states.onsuccess=()=>{const cursor=states.result;if(!cursor)return;if(cursor.value==='ready')settled.add(String(cursor.key));cursor.continue();};
      const format=store.index('format').openKeyCursor();
      format.onsuccess=()=>{const cursor=format.result;if(!cursor)return;const [id,value]=cursor.key as string[];formats.set(id,value as SavedBackup['format']);cursor.continue();};
      const request = store.index('summary').openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          // Only records predating the byte-size metadata require a body read.
          const keys=store.openKeyCursor();
          keys.onsuccess=()=>{const cursor=keys.result;if(!cursor)return;const id=String(cursor.primaryKey);if(seen.has(id)){cursor.continue();return;}const old=store.get(id);old.onsuccess=()=>{try{records.push(summarizeSavedBackup(old.result));cursor.continue();}catch{transaction.abort();}};};
          return;
        }
        // Key cursors read metadata only, even with gigabytes of retained files.
        try {
          const [createdAt,id,kind,byteSize]=cursor.key as [string,string,SavedBackup['kind'],number];
          records.push({id,createdAt,kind,byteSize});seen.add(id);
          cursor.continue();
        } catch { transaction.abort(); }
      };
      transaction.oncomplete = () => {for(const record of records){const format=formats.get(record.id);if(format)record.format=format;Object.assign(record,retention.get(record.id));if(settled.has(record.id))record.retentionState='ready';}db.close(); resolve(); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('バックアップを読み込めませんでした。')); };
    });
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) {
      try { const item = JSON.parse(localStorage.getItem(key) ?? 'null'); if (typeof item?.id === 'string' && typeof item.createdAt === 'string' && typeof item.raw === 'string' && !records.some((record) => record.id === item.id)) records.push(summarizeSavedBackup(item)); } catch { /* Keep unreadable originals untouched. */ }
    }
  }
  return records.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function deleteSavedBackup(id: string): Promise<void> {
  if (typeof indexedDB !== 'undefined') {
    const db=await database();
    try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['backups','retentionStates'],'readwrite');tx.objectStore('backups').delete(id);tx.objectStore('retentionStates').delete(id);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  localStorage.removeItem(PREFIX + id);
  if(typeof indexedDB!=='undefined'){
    const appDb=await(await import('../storage')).openAppDb();
    if(appDb.objectStoreNames.contains('contentBlobRefs')){const tx=appDb.transaction('contentBlobRefs','readwrite'),done=idbDone(tx);tx.objectStore('contentBlobRefs').delete(`backup:${id}`);tx.objectStore('contentBlobRefs').delete(`backup-original:${id}`);await done;}
  }
}

/** The caller holds the synchronization lease and has confirmed all receipts.
 * Updating this small store never clones retained PDF/handwriting bodies. */
export async function settleSavedBackupHistory(ids: string[]): Promise<void> {
  if (!ids.length || typeof indexedDB === 'undefined') return;
  const owner=getAccountStorageSession(),db=await database();
  try {
    if(owner!==getAccountStorageSession())throw new Error('バックアップのアカウントが変わりました。');owner?.assertCurrent();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('retentionStates','readwrite');
      for(const id of ids)tx.objectStore('retentionStates').put('ready',id);
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });
  } finally { db.close(); }
}

/** Convert one immutable legacy backup at a time. Its body and serialized legacy
 * original are one unit; neither is switched until both round-trip exactly. */
export async function migrateBackupBlobs(appDb: IDBDatabase, assertCurrent: () => Promise<void>): Promise<boolean> {
  for (const key of ['wholeFrozen','pushBatch','deltaFrozen','wholeIncoming','pullStage']) if (await readMeta(appDb,key)) return false;
  const marker = await readMeta<{ after: string; complete?: boolean }>(appDb,'backupBlobMigration');
  if(marker?.complete)return true;
  const summaries=await listSavedBackups();
  const next=summaries.filter(row=>row.id>(marker?.after??'')&&row.retentionState!=='pending').sort((a,b)=>a.id.localeCompare(b.id))[0];
  if(!next){const pending=summaries.some(row=>row.retentionState==='pending');await writeMeta(appDb,'backupBlobMigration',{after:pending?'':marker?.after??'',complete:!pending});return !pending;}
  // Pending witnesses are immutable until their legacy receipt has settled.
  if(next.retentionState==='pending')return false;
  await assertCurrent();const source=await operation<StoredBackup|undefined>('readonly',store=>store.get(next.id));
  if(!source)return false;
  if(source.blobVault){await writeMeta(appDb,'backupBlobMigration',{after:source.id,verified:true});return false;}
  const original=typeof source.raw==='string'?source.raw:await source.raw.text();
  const packed=await packBlobNote(appDb,original);
  const legacy=source.legacyOriginalRaw?await packBlobNote(appDb,source.legacyOriginalRaw):undefined;
  if(await unpackBlobNote(appDb,packed)!==original || (legacy&&await unpackBlobNote(appDb,legacy)!==source.legacyOriginalRaw))throw new Error('旧バックアップの全原本を検証できません。元のファイルを保持しています。');
  await assertCurrent();
  const pins=appDb.transaction('contentBlobRefs','readwrite'),pinned=idbDone(pins);
  queueBlobReferences(pins,`backup:${source.id}`,packed);if(legacy)queueBlobReferences(pins,`backup-original:${source.id}`,legacy);await pinned;
  const blob=new Blob([packed],{type:'application/json'}),digest=await hashBackupBlob(blob);
  const replacement:StoredBackup={...source,raw:blob,byteSize:blob.size,blobVault:true,...(legacy?{legacyOriginalRaw:legacy}:{}),...(source.verification?{verification:{...source.verification,digest}}:{})};
  const db=await database();
  try{await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('backups','readwrite'),store=tx.objectStore('backups'),current=store.get(source.id);
    current.onsuccess=()=>{const value=current.result as StoredBackup|undefined;if(!value||value.createdAt!==source.createdAt||value.byteSize!==source.byteSize||value.verification?.digest!==source.verification?.digest){tx.abort();return;}store.put(replacement);};
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('バックアップ移行中に元データが変わりました。'));
  });}finally{db.close();}
  const stored=await operation<StoredBackup|undefined>('readonly',store=>store.get(source.id));
  if(!stored||!(stored.raw instanceof Blob)||await hashBackupBlob(stored.raw)!==digest)throw new Error('バックアップの移行を検証できません。移行記録を保持しています。');
  await assertCurrent();await writeMeta(appDb,'backupBlobMigration',{after:source.id,verified:true});return false;
}
