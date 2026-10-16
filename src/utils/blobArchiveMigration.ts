import { accountDatabaseName } from './accountStorage';
import { blobHash, blobDataUrl, idbDone, idbResult, packBlobNote, queueBlobReferences, readMeta, unpackBlobNote, writeMeta } from './blobVault';

const frozenKeys=['wholeFrozen','pushBatch','deltaFrozen'];
async function settled(db:IDBDatabase){for(const key of frozenKeys)if(await readMeta(db,key))return false;return true;}
/** Immutable rescue/checkpoint files are independent migration units. Unknown
 * object formats remain untouched. A failed verification never advances a key. */
export async function migrateArchiveBlobs(db:IDBDatabase,assertCurrent:()=>Promise<void>):Promise<boolean>{
  if(!await settled(db))return false;
  const marker=await readMeta<{after:string;complete?:boolean}>(db,'archiveBlobMigration');if(marker?.complete)return true;
  const tx=db.transaction('appDataBackups'),done=idbDone(tx),keys=await idbResult(tx.objectStore('appDataBackups').getAllKeys());await done;
  const id=keys.map(String).filter(key=>key>(marker?.after??'')).sort()[0];
  if(!id){await writeMeta(db,'archiveBlobMigration',{after:marker?.after??'',complete:true});return true;}
  const read=db.transaction('appDataBackups'),readDone=idbDone(read),source=await idbResult(read.objectStore('appDataBackups').get(id));await readDone;
  if(typeof source!=='string'&&!(source instanceof Blob)){await writeMeta(db,'archiveBlobMigration',{after:id});return false;}
  const raw=source instanceof Blob?await source.text():source;
  // Invalid rescue bytes stay in their original format and are never discarded.
  try{JSON.parse(raw);}catch{await writeMeta(db,'archiveBlobMigration',{after:id,retainedOriginal:true});return false;}
  const packed=await packBlobNote(db,raw);
  if(packed!==raw){
    if(await unpackBlobNote(db,packed)!==raw)throw new Error('復旧原本の全内容を検証できません。');
    const body=new Blob([packed],{type:'application/json'}),digest=await blobHash(body);
    await assertCurrent();if(!await settled(db))return false;
    const write=db.transaction(['appDataBackups','appRecordMeta','contentBlobRefs'],'readwrite'),written=idbDone(write);
    const current=write.objectStore('appDataBackups').get(id),index=write.objectStore('appRecordMeta').get('wholeRecoveryIndexV1');
    index.onsuccess=()=>{
      if(typeof source==='string'?current.result!==source:!(current.result instanceof Blob)||current.result.size!==source.size){write.abort();return;}
      write.objectStore('appDataBackups').put(body,id);queueBlobReferences(write,`checkpoint:${id}`,packed);
      if(index.result?.items?.some((row:{id:string})=>row.id===id))write.objectStore('appRecordMeta').put({...index.result,items:index.result.items.map((row:{id:string})=>row.id===id?{...row,byteSize:body.size,storageDigest:digest,blobVault:true}:row)},'wholeRecoveryIndexV1');
      write.objectStore('appRecordMeta').put({after:id,verified:true},'archiveBlobMigration');
    };await written;
  }else await writeMeta(db,'archiveBlobMigration',{after:id,verified:true});
  return false;
}

/** Old databases are removed record by record only after *every* version for
 * that key has an exact, verified, pinned archive in the account's new vault. */
export async function migrateLegacyBlobSources(db:IDBDatabase,assertCurrent:()=>Promise<void>):Promise<boolean>{
  if((await readMeta<{complete:boolean}>(db,'legacyBlobMigration'))?.complete)return true;
  if(!await settled(db)||!indexedDB.databases)return false;
  const existing=await indexedDB.databases();
  for(const [base,stores,migration] of [
    ['quiz-make-notes-v1',['categoryNotes','categoryNoteBackups'],'notesMigrationV1'],
    ['quiz-make-local-question-images-v1',['images'],'questionImageMigrationV1'],
  ] as const){
    if(await readMeta(db,migration)!==1)continue;
    const info=existing.find(item=>item.name===accountDatabaseName(base));if(!info?.name)continue;
    const legacy=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(info.name!,info.version);r.onupgradeneeded=()=>r.transaction?.abort();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{
      const names=stores.filter(name=>legacy.objectStoreNames.contains(name));if(!names.length)continue;
      const read=legacy.transaction(names),done=idbDone(read),all=names.map(name=>read.objectStore(name).getAllKeys());await done;
      const id=[...new Set(all.flatMap(r=>r.result).map(String))].sort()[0];if(!id)continue;
      const source=legacy.transaction(names),sourced=idbDone(source),requests=names.map(name=>source.objectStore(name).get(id));await sourced;
      const archives:Array<{id:string;raw:string;packed:string}>=[], imageHashes=new Map<number,string>();
      for(let i=0;i<names.length;i++){
        const value=requests[i].result;if(value===undefined)continue;
        let raw:string;
        if(typeof value==='string'){try{JSON.parse(value);}catch{return false;}raw=value;}
        else if(value.blob instanceof Blob){const {blob,...metadata}=value;imageHashes.set(i,await blobHash(blob));raw=JSON.stringify({kind:'legacy-image-original',...metadata,dataUrl:await blobDataUrl(blob)});}
        else return false;
        const packed=await packBlobNote(db,raw);if(await unpackBlobNote(db,packed)!==raw)throw new Error('旧保存領域の原本を検証できません。');
        archives.push({id:`legacy-original:${base}:${names[i]}:${id}`,raw,packed});
      }
      await assertCurrent();if(!await settled(db))return false;
      const write=db.transaction(['appDataBackups','contentBlobRefs'],'readwrite'),written=idbDone(write);
      for(const archive of archives){write.objectStore('appDataBackups').put(archive.packed,archive.id);queueBlobReferences(write,`checkpoint:${archive.id}`,archive.packed);}await written;
      for(const archive of archives){const check=db.transaction('appDataBackups'),checked=idbDone(check),stored=await idbResult(check.objectStore('appDataBackups').get(archive.id));await checked;if(await unpackBlobNote(db,stored)!==archive.raw)throw new Error('旧保存領域の読み戻しを確認できません。');}
      await assertCurrent();if(!await settled(db))return false;
      const remove=legacy.transaction(names,'readwrite'),removed=idbDone(remove);
      names.forEach((name,i)=>{const current=remove.objectStore(name).get(id);current.onsuccess=()=>{
        const original=requests[i].result,value=current.result;
        const same=typeof original==='string'?value===original:original===undefined?value===undefined:value?.blob?.size===original.blob?.size&&value?.addedAt===original.addedAt&&value?.id===original.id;
        if(!same){remove.abort();return;}
        if(value?.blob instanceof Blob){
          // Hold only this legacy store while checking the last-read bytes;
          // the new account database remains available for normal saves.
          let checking=true;const keepAlive=()=>{if(checking){const r=remove.objectStore(name).getKey(id);r.onsuccess=keepAlive;}};keepAlive();
          void blobHash(value.blob).then(hash=>{checking=false;if(hash!==imageHashes.get(i))remove.abort();else remove.objectStore(name).delete(id);},()=>{checking=false;remove.abort();});
        }else remove.objectStore(name).delete(id);
      };});await removed;return false;
    }finally{legacy.close();}
  }
  await writeMeta(db,'legacyBlobMigration',{complete:true});return true;
}
