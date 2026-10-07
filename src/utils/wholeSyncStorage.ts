import { APP_COLLECTIONS, type AppRecordState } from './appRecordStorage';
import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import { validateRecordPullPage, type RemoteRecordChange } from './recordSyncPull';
import type { WholeSyncBaseline } from './wholeSyncDecision';
import { readUserEditGeneration } from './userEditGeneration';
import { SyncProtocolError } from './syncInterruption';
import { isChunkInternal } from './recordChunkFormat';

export const WHOLE_EVENT='quiz-make-whole-sync-changed';
export interface WholeIncoming {version:1;connection:RecordSyncConnection;revision:number;afterKey:string;complete:boolean}
export interface WholeSummary {sets:number;questions:number;answers:number;plans:number;images:number;pdfs:number}
export interface WholeConflict {version:1;connection:RecordSyncConnection;revision:number;generation:number;localDigest:string;remoteDigest:string;device:string|null;savedAt:string|null;localSavedAt?:string;localDevice?:string;local:WholeSummary;remote:WholeSummary;choice?:'local'|'remote'}
export interface WholeFrozen {version:1;connection:RecordSyncConnection;id:string;expectedRevision:number;generation:number;digest:string;wireDigest:string;parts:Array<{id:string;raw:string}>;records:number;device:string;replace:boolean;outbox:Array<{key:string;operationId:string}>;nextPart?:number}
type WholeProgress=Pick<WholeFrozen,'version'|'connection'|'id'|'wireDigest'>&{nextPart:number};
const progressOf=(value:WholeFrozen,nextPart=value.nextPart??0):WholeProgress=>({version:1,connection:value.connection,id:value.id,wireDigest:value.wireDigest,nextPart});
const safe=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('全体同期を端末へ保存できません。'))});
export async function readWholeMeta<T>(db:IDBDatabase,key:'wholeBaseline'|'wholeIncoming'|'wholeConflict'|'wholeFrozen',connection:RecordSyncConnection):Promise<T|undefined>{
  const tx=db.transaction('appRecordMeta'),completion=done(tx),meta=tx.objectStore('appRecordMeta'),request=meta.get(key),progress=key==='wholeFrozen'?meta.get('wholeFrozenProgress'):undefined;await completion;
  const value=key==='wholeFrozen'&&request.result?withProgress(request.result,progress?.result):request.result;
  if(value && (value.version!==1||!value.connection||!sameRecordSyncConnection(value.connection,connection)))throw new SyncProtocolError('connection_changed','全体同期の保存先が変わりました。原本を保持しています。');
  if(value&&key==='wholeIncoming'&&(!safe(value.revision)||typeof value.afterKey!=='string'||value.afterKey.length>2048||typeof value.complete!=='boolean'))throw new SyncProtocolError('invalid_response','全体受信の途中状態を確認できません。');
  if(value&&key==='wholeConflict'&&(!safe(value.revision)||!safe(value.generation)||!/^[a-f0-9]{64}$/.test(value.localDigest)||!/^[a-f0-9]{64}$/.test(value.remoteDigest)||value.choice!==undefined&&!['local','remote'].includes(value.choice)))throw new SyncProtocolError('invalid_response','全体の選択を確認できません。');
  if(value&&key==='wholeFrozen')validateWholeFrozen(value);
  return value;
}
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function validateWholeFrozen(value:WholeFrozen):void{
  if(!uuid(value.id)||!safe(value.expectedRevision)||!safe(value.generation)||!safe(value.records)||value.records>200000||typeof value.replace!=='boolean'
    ||typeof value.device!=='string'||!value.device||new TextEncoder().encode(value.device).length>160
    ||!(/^[a-f0-9]{64}$/.test(value.digest)&&/^[a-f0-9]{64}$/.test(value.wireDigest))
    ||!Array.isArray(value.parts)||!value.parts.length||value.parts.length>512||value.parts.some(part=>!uuid(part.id)||typeof part.raw!=='string'||new TextEncoder().encode(part.raw).length>1048576)
    ||new Set(value.parts.map(part=>part.id)).size!==value.parts.length
    ||value.nextPart!==undefined&&(!safe(value.nextPart)||value.nextPart>value.parts.length)
    ||!Array.isArray(value.outbox)||value.outbox.some(row=>typeof row.key!=='string'||!uuid(row.operationId)))throw new SyncProtocolError('invalid_response','未確認の全体送信原本を検証できません。原本を保持しています。');
}
function withProgress(value:WholeFrozen,progress:WholeProgress|undefined):WholeFrozen{
  // Pre-upgrade originals carry their cursor inline. Read them unchanged until
  // their first successful part creates the small cursor, without rewriting bytes.
  if(!progress)return value;
  if(!safe(progress.nextPart)||progress.nextPart>value.parts.length||JSON.stringify(progress)!==JSON.stringify(progressOf(value,progress.nextPart)))throw new SyncProtocolError('invalid_response','全体送信の再開位置が原本と一致しません。原本を保持しています。');
  return {...value,nextPart:progress.nextPart};
}
function matchesFrozen(current:WholeFrozen|undefined,value:WholeFrozen,progress:WholeProgress|undefined):boolean{
  if(!current)return false;const saved=withProgress(current,progress);
  return JSON.stringify({...saved,nextPart:saved.nextPart??0})===JSON.stringify({...value,nextPart:value.nextPart??0});
}
export async function advanceWholePart(db:IDBDatabase,value:WholeFrozen,nextPart:number):Promise<WholeFrozen>{
  if(!safe(nextPart)||nextPart!==(value.nextPart??0)+1||nextPart>value.parts.length)throw new SyncProtocolError('invalid_response','全体送信の再開位置を進められません。');
  const tx=db.transaction('appRecordMeta','readwrite'),completion=done(tx),meta=tx.objectStore('appRecordMeta'),current=meta.get('wholeFrozenProgress');
  current.onsuccess=()=>{try{
    if(current.result){if(JSON.stringify(current.result)!==JSON.stringify(progressOf(value))){tx.abort();return}meta.put(progressOf(value,nextPart),'wholeFrozenProgress');}
    else {const legacy=meta.get('wholeFrozen');legacy.onsuccess=()=>{try{if(!matchesFrozen(legacy.result,value,undefined)){tx.abort();return}meta.put(progressOf(value,nextPart),'wholeFrozenProgress')}catch{tx.abort()}}}
  }catch{tx.abort()}};await completion;return {...value,nextPart};
}
/** Freeze exactly the observed whole state; a concurrent save must never turn
 * a verified whole choice into a different request. */
export async function freezeWholeUpload(db:IDBDatabase,value:WholeFrozen,expectedCommitId:string,archive?:(tx:IDBTransaction)=>void):Promise<void>{
  validateWholeFrozen(value);
  const tx=db.transaction(['appRecordMeta','appDataBackups'],'readwrite'),completion=done(tx),meta=tx.objectStore('appRecordMeta');
  let changed=false;
  const state=meta.get('state'),generation=meta.get('userEditGenerationV1'),prior=meta.get('wholeFrozen'),binding=meta.get('recordSyncConnection');
  binding.onsuccess=()=>{try{
    if(prior.result||state.result?.commitId!==expectedCommitId||(generation.result??0)!==value.generation||!binding.result||!sameRecordSyncConnection(binding.result,value.connection)){changed=true;throw new Error()}
    archive?.(tx);meta.put({...value,nextPart:undefined},'wholeFrozen');meta.put(progressOf(value),'wholeFrozenProgress');
  }catch{tx.abort()}};
  try{await completion}catch{throw new SyncProtocolError(changed?'local_changed':'local_persistence_failed',changed?'確認中に端末の内容が変わりました。両方を保持して再確認します。':'復旧コピーと全体送信を端末へ保存できません。両方のデータを保持しています。')}
  window.dispatchEvent(new Event(WHOLE_EVENT));
}
/** Only after an authoritative abort/conflict says this exact UUID did not commit. */
export async function releaseWholeUpload(db:IDBDatabase,value:WholeFrozen):Promise<void>{
  const tx=db.transaction('appRecordMeta','readwrite'),completion=done(tx),meta=tx.objectStore('appRecordMeta'),request=meta.get('wholeFrozen'),progress=meta.get('wholeFrozenProgress');
  progress.onsuccess=()=>{try{if(!matchesFrozen(request.result,value,progress.result)){tx.abort();return}meta.delete('wholeFrozen');meta.delete('wholeFrozenProgress')}catch{tx.abort()}};
  await completion;window.dispatchEvent(new Event(WHOLE_EVENT));
}
export async function readWholeBaseline(db:IDBDatabase,connection:RecordSyncConnection):Promise<WholeSyncBaseline|undefined>{
  const value=await readWholeMeta<WholeSyncBaseline>(db,'wholeBaseline',connection);
  if(value&&(!safe(value.serverRevision)||!safe(value.userGeneration)||!/^[a-f0-9]{64}$/.test(value.digest)))throw new SyncProtocolError('invalid_response','全体同期の共通祖先を確認できません。');
  return value;
}
export async function readVerifiedWholeAncestorCursor(db:IDBDatabase,connection:RecordSyncConnection):Promise<number|undefined>{
  const tx=db.transaction('appRecordMeta'),completion=done(tx),meta=tx.objectStore('appRecordMeta'),cursor=meta.get('pullCursor'),stage=meta.get('pullStage');await completion;
  if(stage.result)return undefined;
  if(!cursor.result)return undefined;
  if(!sameRecordSyncConnection(cursor.result.connection,connection)||!safe(cursor.result.cursor))throw new SyncProtocolError('connection_changed','以前の読込結果の保存先を確認できません。');
  return cursor.result.cursor;
}
export async function putWholeMeta(db:IDBDatabase,key:'wholeConflict'|'wholeFrozen',value:WholeConflict|WholeFrozen):Promise<void>{
  const tx=db.transaction('appRecordMeta','readwrite'),completion=done(tx),meta=tx.objectStore('appRecordMeta');
  if(key==='wholeFrozen'){meta.put({...value,nextPart:undefined},key);meta.put(progressOf(value as WholeFrozen),'wholeFrozenProgress')}else meta.put(value,key);
  await completion;window.dispatchEvent(new Event(WHOLE_EVENT));
}
export async function chooseWholeConflict(db:IDBDatabase,connection:RecordSyncConnection,shown:WholeConflict,choice:'local'|'remote'):Promise<void>{
  const tx=db.transaction('appRecordMeta','readwrite'),completion=done(tx),current=tx.objectStore('appRecordMeta').get('wholeConflict'),generation=tx.objectStore('appRecordMeta').get('userEditGenerationV1');
  generation.onsuccess=()=>{try{
    if((generation.result??0)!==shown.generation||JSON.stringify(current.result)!==JSON.stringify(shown)||!sameRecordSyncConnection(shown.connection,connection))throw new Error();
    tx.objectStore('appRecordMeta').put({...shown,choice},'wholeConflict');
  }catch{tx.abort()}};
  await completion;window.dispatchEvent(new Event(WHOLE_EVENT));
}
export async function stageWholePage(db:IDBDatabase,connection:RecordSyncConnection,revision:number,afterKey:string,value:unknown):Promise<WholeIncoming>{
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>4*1024*1024)throw new SyncProtocolError('payload_too_large','全体受信のページが大きすぎます。');
  const page=value as {code:string;revision:number;rows:RemoteRecordChange[];afterKey:string;hasMore:boolean};
  if(!page||page.code!=='ok'||page.revision!==revision||!safe(revision)||!Array.isArray(page.rows)||page.rows.length>500||typeof page.hasMore!=='boolean'||typeof page.afterKey!=='string'
    || (page.rows.length?page.afterKey!==page.rows[page.rows.length-1].key:page.afterKey!==afterKey)||(!page.rows.length&&page.hasMore))throw new SyncProtocolError('invalid_response','全体受信のページを確認できません。');
  const parsed=page.rows.length?validateRecordPullPage({code:'ok',cursor:1,head:1,hasMore:false,batches:[{revision:1,changes:page.rows.map(row=>({...row,revision:1}))}]},0).batches[0].changes:[];
  const rows=parsed.map((row,i)=>{if(!safe(page.rows[i].revision)||page.rows[i].revision>revision||row.raw===null)throw new SyncProtocolError('invalid_response','全体受信のレコードを確認できません。');return {...row,revision:page.rows[i].revision}});
  const tx=db.transaction(['appRecordMeta','appPullStage','appPullMedia'],'readwrite'),completion=done(tx),current=tx.objectStore('appRecordMeta').get('wholeIncoming');
  const next:WholeIncoming={version:1,connection,revision,afterKey:page.afterKey,complete:!page.hasMore};
  current.onsuccess=()=>{try{
    const previous=current.result as WholeIncoming|undefined;
    if(previous&&!sameRecordSyncConnection(previous.connection,connection))throw new Error();
    if(afterKey){if(!previous||!sameRecordSyncConnection(previous.connection,connection)||previous.revision!==revision||previous.afterKey!==afterKey||previous.complete)throw new Error();}
    else {tx.objectStore('appPullStage').clear();tx.objectStore('appPullMedia').clear();}
    for(const row of rows){
      const existing=tx.objectStore('appPullStage').get(row.key);
      existing.onsuccess=()=>{try{if(afterKey&&existing.result)throw new Error();tx.objectStore('appPullStage').put(row,row.key)}catch{tx.abort()}};
    }
    tx.objectStore('appRecordMeta').put(next,'wholeIncoming');
  }catch{tx.abort()}};await completion;return next;
}
export async function readWholeRows(db:IDBDatabase,connection:RecordSyncConnection,revision:number):Promise<RemoteRecordChange[]>{
  const incoming=await readWholeMeta<WholeIncoming>(db,'wholeIncoming',connection);
  if(!incoming?.complete||incoming.revision!==revision)throw new SyncProtocolError('invalid_response','全体の受信が完了していません。');
  const tx=db.transaction('appPullStage'),completion=done(tx),request=tx.objectStore('appPullStage').getAll();await completion;
  const rows=request.result as RemoteRecordChange[];
  for(let i=0;i<rows.length;i+=500){validateRecordPullPage({code:'ok',cursor:1,head:1,hasMore:false,batches:[{revision:1,changes:rows.slice(i,i+500).map(row=>({...row,revision:1}))}]},0)}
  if(rows.some(row=>row.raw===null||!safe(row.revision)||row.revision>revision))throw new SyncProtocolError('invalid_response','保存済みの全体受信を検証できません。');
  return rows;
}
export function queueWholeBaseline(tx:IDBTransaction,baseline:WholeSyncBaseline):void{
  tx.objectStore('appRecordMeta').put(baseline,'wholeBaseline');
  tx.objectStore('appRecordMeta').delete('wholeConflict');
  tx.objectStore('appRecordMeta').put({connection:baseline.connection,cursor:baseline.serverRevision},'pullCursor');
}
/** Called after every primary/auxiliary write was queued in the shared TX. */
export function queueWholeReplacement(tx:IDBTransaction,rows:RemoteRecordChange[],baseline:WholeSyncBaseline):void{
  const meta=tx.objectStore('appRecordMeta'),state=meta.get('state');
  state.onsuccess=()=>{try{
    const current=state.result as AppRecordState;if(!current)throw new Error();
    tx.objectStore('appRecords').clear();tx.objectStore('appOutbox').clear();tx.objectStore('appRecordConflicts').clear();
    for(const row of rows)tx.objectStore('appRecords').put({key:row.key,collection:row.collection,id:row.id,raw:row.raw,...(row.logicalRaw!==undefined?{logicalRaw:row.logicalRaw}:{}),position:row.position,serverRevision:row.revision,localRevision:current.revision},row.key);
    queueWholeBaseline(tx,baseline);
    for(const key of ['pushBatch','pullStage','wholeIncoming','wholeFrozen','wholeFrozenProgress'])meta.delete(key);
    tx.objectStore('appPullStage').clear();tx.objectStore('appPullMedia').clear();
    const counts=Object.fromEntries(APP_COLLECTIONS.map(collection=>[collection,rows.filter(row=>row.collection===collection&&row.raw!==null).length]));
    meta.put({...current,counts,commitId:crypto.randomUUID()},'state');
  }catch{tx.abort()}};
}
export async function acknowledgeWholeUpload(db:IDBDatabase,frozen:WholeFrozen,revision:number):Promise<void>{
  if(!safe(revision)||revision!==frozen.expectedRevision+1)throw new SyncProtocolError('invalid_response','全体保存の確認結果が不正です。');
  const sent=frozen.parts.flatMap(part=>JSON.parse(part.raw) as RemoteRecordChange[]);
  const tx=db.transaction(['appRecordMeta','appOutbox','appRecords','appPullStage','appPullMedia'],'readwrite'),completion=done(tx),current=tx.objectStore('appRecordMeta').get('wholeFrozen'),progress=tx.objectStore('appRecordMeta').get('wholeFrozenProgress'),incoming=tx.objectStore('appRecordMeta').get('wholeIncoming'),state=tx.objectStore('appRecordMeta').get('state');
  state.onsuccess=()=>{try{
    if(!matchesFrozen(current.result,frozen,progress.result))throw new Error();
    for(const row of frozen.outbox){const existing=tx.objectStore('appOutbox').get(row.key);existing.onsuccess=()=>{if(existing.result?.operationId===row.operationId)tx.objectStore('appOutbox').delete(row.key)}};
    queueWholeBaseline(tx,{version:1,connection:frozen.connection,serverRevision:revision,userGeneration:frozen.generation,digest:frozen.digest});
    for(const row of sent){const existing=tx.objectStore('appRecords').get(row.key);existing.onsuccess=()=>{try{if(existing.result?.raw===row.raw&&existing.result.position===row.position)tx.objectStore('appRecords').put({...existing.result,serverRevision:revision},row.key)}catch{tx.abort()}}}
    if(state.result)tx.objectStore('appRecordMeta').put({...state.result,commitId:crypto.randomUUID()},'state');
    if(!incoming.result||sameRecordSyncConnection(incoming.result.connection,frozen.connection)&&incoming.result.revision<=frozen.expectedRevision){
      for(const key of ['wholeIncoming','pullStage'])tx.objectStore('appRecordMeta').delete(key);
      tx.objectStore('appPullStage').clear();tx.objectStore('appPullMedia').clear();
    }
    tx.objectStore('appRecordMeta').delete('wholeFrozen');tx.objectStore('appRecordMeta').delete('wholeFrozenProgress');
  }catch{tx.abort()}};await completion;window.dispatchEvent(new Event(WHOLE_EVENT));
}
export async function acknowledgeIdenticalWhole(db:IDBDatabase,baseline:WholeSyncBaseline):Promise<void>{
  if(await readUserEditGeneration(db)!==baseline.userGeneration)throw new SyncProtocolError('local_changed','確認中に端末の内容が変わりました。');
  const tx=db.transaction(['appRecordMeta','appOutbox','appPullStage','appPullMedia'],'readwrite'),completion=done(tx),meta=tx.objectStore('appRecordMeta'),old=meta.get('pushBatch'),frozen=meta.get('wholeFrozen'),generation=meta.get('userEditGenerationV1');
  generation.onsuccess=()=>{if(old.result||frozen.result||(generation.result??0)!==baseline.userGeneration){tx.abort();return;}tx.objectStore('appOutbox').clear();queueWholeBaseline(tx,baseline);for(const key of ['wholeIncoming','pullStage'])meta.delete(key);tx.objectStore('appPullStage').clear();tx.objectStore('appPullMedia').clear()};
  await completion;window.dispatchEvent(new Event(WHOLE_EVENT));
}
export function summarizeWholeRows(rows:RemoteRecordChange[]):WholeSummary{
  return {sets:rows.filter(row=>row.collection==='problemSets').length,questions:rows.filter(row=>row.collection==='questions').length,answers:rows.filter(row=>row.collection==='answerLogs').length,
    plans:rows.filter(row=>row.collection==='localStorage'&&row.id.startsWith('quizMake:plan:')&&!isChunkInternal(row.collection,row.id)).length,images:rows.filter(row=>row.collection==='questionImages').length,
    pdfs:rows.filter(row=>row.collection==='indexedDbNotes'&&row.id.includes(':__material_pdf_')).length};
}
