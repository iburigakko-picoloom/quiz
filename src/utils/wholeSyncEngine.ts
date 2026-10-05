import { appRecordKey, readAppRecordSnapshot, readAppOutbox, type AppRecord } from './appRecordStorage';
import { acknowledgeRecordPushBatch, bindRecordSyncConnection, getPendingRecordPushBatch, releaseRejectedRecordPushBatch, type RecordPushAcknowledgement, type RecordSyncConnection } from './recordSyncOutbox';
import { validateRecordPullPage, type RemoteRecordChange } from './recordSyncPull';
import type { RecordSyncGuards, RecordSyncOutcome, RecordSyncTransport } from './recordSyncEngine';
import { hydrateChunkChanges } from './recordChunks';
import { readUserEditGeneration } from './userEditGeneration';
import { withCoordinatedDataRead } from './dataCoordination';
import { SyncProtocolError } from './syncInterruption';
import { decideWholeSync } from './wholeSyncDecision';
import { computeWholeRecordDigest, wholeHash } from './wholeSyncDigest';
import { acknowledgeIdenticalWhole, acknowledgeWholeUpload, advanceWholePart, freezeWholeUpload, putWholeMeta, queueWholeReplacement, readWholeBaseline, readWholeMeta, readWholeRows, readVerifiedWholeAncestorCursor, releaseWholeUpload, stageWholePage, summarizeWholeRows, validateWholeFrozen, type WholeConflict, type WholeFrozen, type WholeIncoming } from './wholeSyncStorage';
import { applyWholeSyncFile, exportFileBackup, type FileBackup } from './backupPayload';
import { prepareWholeRecovery } from './wholeRecovery';
import { materialFileEntry } from './materialModel';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { remoteQuestionImageDescriptor } from './questionImageCloud';
import { chunkIds, isChunkInternal, parseChunkManifest, RECORD_CHUNK_GUARD_ID } from './recordChunkFormat';

type Reply={code:string;[key:string]:unknown};
export type WholeTransport=RecordSyncTransport&{whole(name:'status'|'open'|'read'|'begin'|'part'|'finish'|'abort'|'receipts',body?:Record<string,unknown>):Promise<Reply>};
type WholeGuards=Omit<RecordSyncGuards,'prepareOutgoing'>&{prepareOutgoing():Promise<void|{more:boolean}>;incoming(rows:RemoteRecordChange[]):Promise<FileBackup>;device:string};
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
function head(value:Reply){
  if(value.code!=='ok'||!integer(value.revision)||typeof value.enabled!=='boolean'||!(value.device===null||typeof value.device==='string')||!(value.savedAt===null||typeof value.savedAt==='string'&&Number.isFinite(Date.parse(value.savedAt))))throw new SyncProtocolError(value.code,'全体同期の保存状態を確認できません。');
  return {revision:value.revision,enabled:value.enabled,device:value.device,savedAt:value.savedAt};
}
function requireOk(value:Reply){if(value.code!=='ok')throw new SyncProtocolError(value.code,'全体保存の結果を確認できません。送信原本を保持しています。')}
const wire=(row:{key:string;collection:string;id:string;raw:string|null;position:number})=>({key:row.key,collection:row.collection,id:row.id,raw:row.raw,position:row.position});
function mediaReady(row:AppRecord,connection:RecordSyncConnection){
  if(row.raw===null)return;
  if(row.collection==='questionImages'){
    const descriptor=parseQuestionImageDescriptor(row.raw);
    if(descriptor.id!==row.id||descriptor.path!==remoteQuestionImageDescriptor(descriptor,connection.userId).path)throw new SyncProtocolError('media_pending','画像本体の保存が未確認です。');
  }
  if(row.collection==='indexedDbNotes'&&materialFileEntry(row.id,row.logicalRaw??row.raw)?.kind==='quiz-material-file')throw new SyncProtocolError('media_pending','PDF本体の保存が未確認です。');
}
async function pack(rows:Array<ReturnType<typeof wire>>):Promise<{parts:WholeFrozen['parts'];wireDigest:string}>{
  const groups:string[]=[],parts:WholeFrozen['parts']=[];let current:string[]=[],bytes=2;
  for(const row of rows){const raw=JSON.stringify(row),size=new TextEncoder().encode(raw).length+1;if(size+2>921600)throw new SyncProtocolError('payload_too_large','全体送信の1レコードが大きすぎます。');
    if(current.length&&(bytes+size>921600||current.length===500)){groups.push('['+current.join(',')+']');current=[];bytes=2}current.push(raw);bytes+=size;}
  if(current.length||!groups.length)groups.push('['+current.join(',')+']');
  if(groups.length>512||rows.length>200000)throw new SyncProtocolError('payload_too_large','全体送信の上限を超えています。');
  let hashes='';for(const raw of groups){parts.push({id:crypto.randomUUID(),raw});hashes+=await wholeHash(raw)}
  return {parts,wireDigest:await wholeHash(hashes)};
}
/** Resolve exact persisted requests before considering a different whole state. */
export async function sendFrozenWhole(db:IDBDatabase,transport:WholeTransport,guards:Pick<WholeGuards,'assertCurrent'|'step'>,original:WholeFrozen,maxParts=20):Promise<'committed'|'rejected'|'more'>{
  validateWholeFrozen(original);
  let frozen=original,hashes='',count=0,keys=new Set<string>();
  for(const part of frozen.parts){hashes+=await wholeHash(part.raw);const rows=JSON.parse(part.raw) as Array<ReturnType<typeof wire>>;if(!Array.isArray(rows)||rows.length>500)throw new SyncProtocolError('invalid_response','保存済み送信原本を検証できません。');
    if(rows.length)validateRecordPullPage({code:'ok',cursor:1,head:1,hasMore:false,batches:[{revision:1,changes:rows.map(row=>({...row,revision:1}))}]},0);
    for(const row of rows){if(keys.has(row.key)||frozen.replace&&row.raw===null)throw new SyncProtocolError('invalid_response','保存済み送信原本が重複しています。');keys.add(row.key);count++}}
  if(await wholeHash(hashes)!==frozen.wireDigest||count!==frozen.records)throw new SyncProtocolError('invalid_response','保存済み送信原本のハッシュが一致しません。');
  const reject=async():Promise<'committed'|'rejected'>=>{
    await guards.assertCurrent();const result=await transport.whole('abort',{p_operation_id:frozen.id});
    if(result.code==='committed'&&integer(result.revision)){await acknowledgeWholeUpload(db,frozen,result.revision);return 'committed'}
    if(result.code!=='not_committed')throw new SyncProtocolError(result.code,'全体保存の結果を確認できません。');
    await releaseWholeUpload(db,frozen);return 'rejected';
  };
  await guards.assertCurrent();guards.step?.('push');
  const begin=await transport.whole('begin',{p_operation_id:frozen.id,p_expected_revision:frozen.expectedRevision,p_parts:frozen.parts.length,p_records:frozen.records,p_digest:frozen.wireDigest,p_device:frozen.device,p_replace:frozen.replace});
  if(begin.code==='conflict'||begin.code==='expired')return reject();requireOk(begin);
  if(begin.state==='committed'){if(!integer(begin.revision))throw new SyncProtocolError('invalid_response','全体保存の版を確認できません。');await acknowledgeWholeUpload(db,frozen,begin.revision);return 'committed'}
  if(begin.state!=='staging')throw new SyncProtocolError('invalid_response','全体保存の段階を確認できません。');
  const stop=Math.min(frozen.parts.length,(frozen.nextPart??0)+maxParts);
  for(let i=frozen.nextPart??0;i<stop;i++){
    await guards.assertCurrent();const part=frozen.parts[i],value=await transport.whole('part',{p_commit_id:frozen.id,p_operation_id:part.id,p_number:i,p_raw:part.raw});
    if(value.code==='conflict'||value.code==='expired')return reject();requireOk(value);await guards.assertCurrent();frozen=await advanceWholePart(db,frozen,i+1);
  }
  if(stop<frozen.parts.length)return 'more';
  await guards.assertCurrent();const finish=await transport.whole('finish',{p_operation_id:frozen.id});
  if(finish.code==='conflict'||finish.code==='expired')return reject();requireOk(finish);
  if(!integer(finish.revision))throw new SyncProtocolError('invalid_response','全体保存の版を確認できません。');
  await guards.assertCurrent();await acknowledgeWholeUpload(db,frozen,finish.revision);return 'committed';
}

/** Existing record transport, staging stores and UI apply guard, with one CAS
 * boundary for the entire dataset. No row-level resolution or history union. */
export async function runWholeRecordSync(db:IDBDatabase,connection:RecordSyncConnection,transport:WholeTransport,guards:WholeGuards,maxPages=20):Promise<RecordSyncOutcome>{
  const result=(status:'done'|'more'|'deferred',uploaded=0,downloaded=0):RecordSyncOutcome=>({status,uploaded,downloaded});
  await guards.assertCurrent();await bindRecordSyncConnection(db,connection);
  let remote=head(await transport.whole('status'));
  const old=await getPendingRecordPushBatch(db,connection);
  if(old){
    let receipt=remote.enabled?await transport.whole('receipts',{p_operations:old.operations}):await transport.push(old.operations) as Reply;
    if(receipt.code==='whole_required')receipt=await transport.whole('receipts',{p_operations:old.operations});
    await guards.assertCurrent();
    if(receipt.code==='ok')await acknowledgeRecordPushBatch(db,old,receipt as RecordPushAcknowledgement);
    else if(receipt.code==='conflict'||receipt.code==='not_committed')await releaseRejectedRecordPushBatch(db,old);
    else throw new SyncProtocolError(receipt.code,'以前の未確認送信を保持しています。');
    remote=head(await transport.whole('status'));
  }
  const frozen=await readWholeMeta<WholeFrozen>(db,'wholeFrozen',connection);
  if(frozen){const sent=await sendFrozenWhole(db,transport,guards,frozen);return result('more',sent==='committed'?frozen.records:0)}
  // Open only this selected owned stream. Rollout is gated by the coordinator.
  if(!remote.enabled){const opened=await transport.whole('open',{p_expected_revision:remote.revision});if(opened.code==='conflict')return result('more');requireOk(opened);remote=head(await transport.whole('status'))}
  const prepared=await guards.prepareOutgoing();if(prepared?.more)return result('more');await guards.assertCurrent();
  const source=await withCoordinatedDataRead(['app','notes'],async()=>{
    const snapshot=await readAppRecordSnapshot(db);if(!snapshot)throw new Error('端末の保存データがありません。');
    return {snapshot,generation:await readUserEditGeneration(db),outbox:await readAppOutbox(db)};
  },{requireCrossContext:true});
  const baseline=await readWholeBaseline(db,connection);
  if(baseline?.serverRevision===remote.revision&&baseline.userGeneration===source.generation&&!source.outbox.length)return result('done');
  const localRows=[...source.snapshot.records.values()].filter(row=>row.raw!==null).map(row=>({...row,revision:row.serverRevision}));
  const localDigest=await computeWholeRecordDigest(localRows);
  let decision:'same'|'upload'|'download'|'conflict',incoming:RemoteRecordChange[]|undefined,remoteDigest=baseline?.digest??'',downloaded=0;
  if(baseline?.serverRevision===remote.revision&&(localDigest===baseline.digest||source.generation!==baseline.userGeneration)){
    decision=decideWholeSync({baseline,serverRevision:remote.revision,userGeneration:source.generation,localDigest,remoteDigest});
  }else{
    let stage=await readWholeMeta<WholeIncoming>(db,'wholeIncoming',connection);
    if(stage?.revision!==remote.revision)stage=undefined;
    for(let i=0;!stage?.complete&&i<maxPages;i++){
      await guards.assertCurrent();guards.step?.('pull');const page=await transport.whole('read',{p_expected_revision:remote.revision,p_after_key:stage?.afterKey??'',p_limit:200});
      if(page.code==='conflict')return result('more');stage=await stageWholePage(db,connection,remote.revision,stage?.afterKey??'',page);downloaded+=Array.isArray(page.rows)?page.rows.length:0;
    }
    if(!stage?.complete)return result('more',0,downloaded);
    incoming=await hydrateChunkChanges(db,await readWholeRows(db,connection,remote.revision),connection,true);
    remoteDigest=await computeWholeRecordDigest(incoming);
    decision=decideWholeSync({baseline,serverRevision:remote.revision,userGeneration:source.generation,localDigest,remoteDigest,verifiedRecordCursor:await readVerifiedWholeAncestorCursor(db,connection)});
  }
  // Logical equality deliberately ignores wire chunks. Their guard/garbage
  // still needs an acknowledged transfer, without creating a user edit.
  const maintenance=source.outbox.some(row=>isChunkInternal(row.collection,row.id));
  const replaceEqualWire=decision==='same'&&maintenance&&baseline?.serverRevision!==remote.revision;
  if(decision==='same'&&maintenance)decision='upload';
  if(decision==='same'){
    const latest=head(await transport.whole('status'));if(latest.revision!==remote.revision)return result('more');
    await acknowledgeIdenticalWhole(db,{version:1,connection,serverRevision:remote.revision,userGeneration:source.generation,digest:localDigest});return result('done',0,downloaded);
  }
  let selected:'local'|'remote'|undefined;
  if(decision==='conflict'){
    const shown:WholeConflict={version:1,connection,revision:remote.revision,generation:source.generation,localDigest,remoteDigest,device:remote.device,savedAt:remote.savedAt,localSavedAt:source.snapshot.state.savedAt,localDevice:guards.device,local:summarizeWholeRows(localRows),remote:summarizeWholeRows(incoming??[])};
    const prior=await readWholeMeta<WholeConflict>(db,'wholeConflict',connection);
    if(prior&&JSON.stringify({...prior,choice:undefined})===JSON.stringify(shown))selected=prior.choice;
    else await putWholeMeta(db,'wholeConflict',shown);
    if(!selected)return {status:'conflict',conflicts:[],uploaded:0,downloaded};
  }
  if(decision==='download'||selected==='remote'){
    if(!incoming)throw new SyncProtocolError('invalid_response','全体の受信原本がありません。');
    await guards.prepareMedia?.();const file=await guards.incoming(incoming);await guards.assertCurrent();
    // The existing apply guard deliberately blocks network work while its own
    // commit overlay is active. Recheck the immutable head before entering it;
    // preserve this revision as the ancestor if another device then advances it.
    const latest=head(await transport.whole('status'));if(latest.revision!==remote.revision)throw new SyncProtocolError('remote_changed','選択後にクラウドが変わりました。両方を保持して再確認します。');
    const applied=await guards.apply(async options=>{
      if(options?.preserveLiveData)return {applied:false as const,deferred:true as const,commitId:source.snapshot.state.commitId,pushBlocked:true};
      const committed=await applyWholeSyncFile(file,source.generation,tx=>queueWholeReplacement(tx,incoming!,{version:1,connection,serverRevision:remote.revision,userGeneration:source.generation,digest:remoteDigest}),decision==='conflict');
      if(!committed.ok){if(committed.committed)throw new Error(committed.error);throw new SyncProtocolError('local_persistence_failed',committed.error)}
      const snapshot=await readAppRecordSnapshot(db);if(!snapshot)throw new Error('全体保存後の確認に失敗しました。');
      return {applied:true as const,data:JSON.parse(file.localStorage['quiz-make-app-data-v1']),cursor:remote.revision,changed:Math.max(1,incoming!.length),commitId:snapshot.state.commitId};
    });
    return result(applied?.applied?'done':'deferred',0,downloaded);
  }
  let archive:((tx:IDBTransaction)=>void)|undefined;
  if(selected==='local'){
    if(!incoming)throw new SyncProtocolError('invalid_response','保管するクラウド原本がありません。');
    await guards.prepareMedia?.();const cloud=await guards.incoming(incoming),local=await exportFileBackup();
    archive=await prepareWholeRecovery(db,cloud,'conflict',new Blob([JSON.stringify(local)]).size);
  }
  const replace=decision==='conflict'||replaceEqualWire||!baseline||!source.outbox.length;
  const outgoingMap=new Map((replace?localRows:source.outbox).map(row=>[row.key,row]));
  if(!replace)for(const row of source.outbox){
    const manifest=parseChunkManifest(row.raw,row.collection,row.id);if(!manifest)continue;
    for(const id of [RECORD_CHUNK_GUARD_ID,...chunkIds(manifest)]){
      const key=appRecordKey('localStorage',id),dependency=source.snapshot.records.get(key);
      if(!dependency?.raw)throw new SyncProtocolError('invalid_response','全体送信に必要なチャンク原本がありません。');
      outgoingMap.set(key,{...dependency,revision:dependency.serverRevision});
    }
  }
  const outgoing=[...outgoingMap.values()];
  outgoing.forEach(row=>mediaReady(row as AppRecord,connection));
  const packed=await pack(outgoing.map(wire));
  const next:WholeFrozen={version:1,connection,id:crypto.randomUUID(),expectedRevision:remote.revision,generation:source.generation,digest:localDigest,wireDigest:packed.wireDigest,parts:packed.parts,records:outgoing.length,device:guards.device,replace,outbox:source.outbox.map(row=>({key:row.key,operationId:row.operationId}))};
  await guards.assertCurrent();await freezeWholeUpload(db,next,source.snapshot.state.commitId,archive);
  const sent=await sendFrozenWhole(db,transport,guards,next);return result('more',sent==='committed'?next.records:0,downloaded);
}
