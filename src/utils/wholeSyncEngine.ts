import { appRecordKey, readCurrentAppRecordSnapshot as readAppRecordSnapshot, readAppOutbox, type AppRecord } from './appRecordStorage';
import { acknowledgeRecordPushBatch, bindRecordSyncConnection, getPendingRecordPushBatch, releaseRejectedRecordPushBatch, type RecordPushAcknowledgement, type RecordSyncConnection } from './recordSyncOutbox';
import { validateRecordPullPage, type RemoteRecordChange } from './recordSyncPull';
import type { RecordSyncGuards, RecordSyncOutcome, RecordSyncTransport } from './recordSyncEngine';
import { hydrateChunkChanges } from './recordChunks';
import { readUserEditGeneration } from './userEditGeneration';
import { withCoordinatedDataRead } from './dataCoordination';
import { SyncProtocolError, SyncInterruptedError } from './syncInterruption';
import { saveBackupPayload, getSavedBackup, type SavedBackup } from './backupRepository';
import { decideWholeSync } from './wholeSyncDecision';
import { computeWholeRecordDigest, wholeHash } from './wholeSyncDigest';
import { acknowledgeIdenticalWhole, acknowledgeWholeUpload, advanceWholePart, freezeWholeUpload, putWholeMeta, queueWholeReplacement, readWholeBaseline, readWholeMeta, readWholeRows, readVerifiedWholeAncestorCursor, releaseWholeUpload, stageWholePage, summarizeWholeRows, validateWholeFrozen, type WholeConflict, type WholeFrozen, type WholeIncoming } from './wholeSyncStorage';
import { applyWholeSyncFile, exportFileBackup, validateFileBackup, isImageOptionalSyncFile, missingSyncImages, type FileBackup, type PreservedSyncOriginals } from './backupPayload';
import { readLegacyImageSync, acceptsLegacyImages, queueLegacyImageSync } from './legacyImageSync';
import type { SyncProgress, SyncProgressStage } from './syncAttemptStatus';
import { prepareWholeRecovery } from './wholeRecovery';
import { materialFileEntry } from './materialModel';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { remoteQuestionImageDescriptor } from './questionImageCloud';
import { chunkIds, isChunkInternal, parseChunkManifest, RECORD_CHUNK_GUARD_ID } from './recordChunkFormat';

type Reply={code:string;[key:string]:unknown};
export type WholeTransport=RecordSyncTransport&{whole(name:'status'|'open'|'read'|'begin'|'part'|'finish'|'abort'|'receipts',body?:Record<string,unknown>):Promise<Reply>;commitSmallWhole?(body:Record<string,unknown>):Promise<Reply>};
type WholeGuards=Omit<RecordSyncGuards,'prepareOutgoing'>&{prepareOutgoing():Promise<void|{more:boolean}>;incoming(rows:RemoteRecordChange[],options?:{allowMissingImages:boolean}):Promise<FileBackup>;device:string;progress?:(value:SyncProgress)=>void;notice?:(message:string)=>void;archiveOriginals?:(side:'local'|'remote',rows:RemoteRecordChange[])=>Promise<SavedBackup>};
function progress(guards:Pick<WholeGuards,'progress'>,stage:SyncProgressStage,label:string,completed=0,total:number|null=null){try{guards.progress?.({label,completed,total,stage});}catch{/* Informational only. */}}
function mayRescue(error:unknown):boolean{
  if(error instanceof SyncInterruptedError)return false;
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  return !['authentication_required','permission_denied','connection_changed','mode_changed','quota','operation_reused','unavailable'].includes(code);
}
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
export async function sendFrozenWhole(db:IDBDatabase,transport:WholeTransport,guards:Pick<WholeGuards,'assertCurrent'|'step'|'progress'>,original:WholeFrozen,maxParts=20):Promise<'committed'|'rejected'|'more'>{
  validateWholeFrozen(original);
  let frozen=original,hashes='',count=0,keys=new Set<string>();
  progress(guards,'validating','送信内容を検証中',0,frozen.parts.length);
  for(const [index,part] of frozen.parts.entries()){hashes+=await wholeHash(part.raw);const rows=JSON.parse(part.raw) as Array<ReturnType<typeof wire>>;if(!Array.isArray(rows)||rows.length>500)throw new SyncProtocolError('invalid_response','保存済み送信原本を検証できません。');
    if(rows.length)validateRecordPullPage({code:'ok',cursor:1,head:1,hasMore:false,batches:[{revision:1,changes:rows.map(row=>({...row,revision:1}))}]},0);
    for(const row of rows){if(keys.has(row.key)||frozen.replace&&row.raw===null)throw new SyncProtocolError('invalid_response','保存済み送信原本が重複しています。');keys.add(row.key);count++}progress(guards,'validating','送信内容を検証中',index+1,frozen.parts.length)}
  if(await wholeHash(hashes)!==frozen.wireDigest||count!==frozen.records)throw new SyncProtocolError('invalid_response','保存済み送信原本のハッシュが一致しません。');
  const reject=async():Promise<'committed'|'rejected'>=>{
    await guards.assertCurrent();const result=await transport.whole('abort',{p_operation_id:frozen.id});
    if(result.code==='committed'&&integer(result.revision)){await acknowledgeWholeUpload(db,frozen,result.revision);return 'committed'}
    if(result.code!=='not_committed')throw new SyncProtocolError(result.code,'全体保存の結果を確認できません。');
    await releaseWholeUpload(db,frozen);return 'rejected';
  };
  await guards.assertCurrent();guards.step?.('push');
  progress(guards,'sending','データを送信中',frozen.nextPart??0,frozen.parts.length);
  if(transport.commitSmallWhole&&!frozen.replace&&frozen.parts.length===1&&new TextEncoder().encode(frozen.parts[0].raw).byteLength<=131072){
    const part=frozen.parts[0];
    const reply=await transport.commitSmallWhole({p_operation_id:frozen.id,p_expected_revision:frozen.expectedRevision,p_records:frozen.records,p_digest:frozen.wireDigest,p_device:frozen.device,p_part_id:part.id,p_raw:part.raw});
    if(reply.code==='conflict'||reply.code==='expired')return reject();
    if(reply.code!=='unsupported'){
      requireOk(reply);
      if(reply.state!=='committed'||!integer(reply.revision))throw new SyncProtocolError('invalid_response','全体保存の結果を確認できません。送信原本を保持しています。');
      await guards.assertCurrent();await acknowledgeWholeUpload(db,frozen,reply.revision);
      progress(guards,'finalizing','クラウドへ保存しました',1,1);
      return 'committed';
    }
  }
  const begin=await transport.whole('begin',{p_operation_id:frozen.id,p_expected_revision:frozen.expectedRevision,p_parts:frozen.parts.length,p_records:frozen.records,p_digest:frozen.wireDigest,p_device:frozen.device,p_replace:frozen.replace});
  if(begin.code==='conflict'||begin.code==='expired')return reject();requireOk(begin);
  if(begin.state==='committed'){if(!integer(begin.revision))throw new SyncProtocolError('invalid_response','全体保存の版を確認できません。');await acknowledgeWholeUpload(db,frozen,begin.revision);return 'committed'}
  if(begin.state!=='staging')throw new SyncProtocolError('invalid_response','全体保存の段階を確認できません。');
  const stop=Math.min(frozen.parts.length,(frozen.nextPart??0)+maxParts);
  for(let i=frozen.nextPart??0;i<stop;i++){
    await guards.assertCurrent();const part=frozen.parts[i],value=await transport.whole('part',{p_commit_id:frozen.id,p_operation_id:part.id,p_number:i,p_raw:part.raw});
    if(value.code==='conflict'||value.code==='expired')return reject();requireOk(value);await guards.assertCurrent();frozen=await advanceWholePart(db,frozen,i+1);
    progress(guards,'sending','データを送信中',i+1,frozen.parts.length);
  }
  if(stop<frozen.parts.length)return 'more';
  progress(guards,'finalizing','クラウドの保存完了を確認中');
  await guards.assertCurrent();const finish=await transport.whole('finish',{p_operation_id:frozen.id});
  if(finish.code==='conflict'||finish.code==='expired')return reject();requireOk(finish);
  if(!integer(finish.revision))throw new SyncProtocolError('invalid_response','全体保存の版を確認できません。');
  await guards.assertCurrent();await acknowledgeWholeUpload(db,frozen,finish.revision);return 'committed';
}

/** Existing record transport, staging stores and UI apply guard, with one CAS
 * boundary for the entire dataset. No row-level resolution or history union. */
export async function runWholeRecordSync(db:IDBDatabase,connection:RecordSyncConnection,transport:WholeTransport,guards:WholeGuards,maxPages=20):Promise<RecordSyncOutcome>{
  const result=(status:'done'|'more'|'deferred',uploaded=0,downloaded=0):RecordSyncOutcome=>({status,uploaded,downloaded});
  const finishUpload=async(frozen:WholeFrozen,sent:'committed'|'rejected'|'more',downloaded=0)=>{
    if(sent==='committed'&&transport.commitSmallWhole){
      await guards.assertCurrent();
      const latest=head(await transport.whole('status'));
      const settled=await withCoordinatedDataRead(['app','notes'],async()=>latest.enabled&&latest.revision===frozen.expectedRevision+1
        &&await readUserEditGeneration(db)===frozen.generation&&!(await readAppOutbox(db)).length,{requireCrossContext:true});
      if(settled)return result('done',frozen.records,downloaded);
    }
    return result('more',sent==='committed'?frozen.records:0,downloaded);
  };
  await guards.assertCurrent();await bindRecordSyncConnection(db,connection);
  const legacyImages=await readLegacyImageSync(db,connection);
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
  if(frozen){const sent=await sendFrozenWhole(db,transport,guards,frozen);return finishUpload(frozen,sent)}
  const prior=await readWholeMeta<WholeConflict>(db,'wholeConflict',connection);
  const priority=prior?.preferSelected?prior.choice:undefined;
  let preparationError:unknown;
  // Read-only comparison can still offer the healthy cloud if local media is
  // broken. A chosen local upload must finish its preparation before freezing.
  if(priority!=='remote')try{const prepared=await guards.prepareOutgoing();if(prepared?.more)return result('more');}
  catch(error){if(!guards.archiveOriginals||!mayRescue(error))throw error;preparationError=error;}
  await guards.assertCurrent();
  const source=await withCoordinatedDataRead(['app','notes'],async()=>{
    const snapshot=await readAppRecordSnapshot(db);if(!snapshot)throw new Error('端末の保存データがありません。');
    return {snapshot,generation:await readUserEditGeneration(db),outbox:await readAppOutbox(db)};
  },{requireCrossContext:true});
  const baseline=await readWholeBaseline(db,connection);
  if(!priority&&!preparationError&&remote.enabled&&baseline?.serverRevision===remote.revision&&baseline.userGeneration===source.generation&&!source.outbox.length)return result('done');
  const localRows=[...source.snapshot.records.values()].filter(row=>row.raw!==null).map(row=>({...row,revision:row.serverRevision}));
  const localDigest=await computeWholeRecordDigest(localRows);
  let decision:'same'|'upload'|'download'|'conflict',incoming:RemoteRecordChange[]|undefined,remoteDigest=baseline?.digest??'',downloaded=0;
  if(!priority&&remote.enabled&&baseline?.serverRevision===remote.revision&&(localDigest===baseline.digest||source.generation!==baseline.userGeneration)){
    decision=decideWholeSync({baseline,serverRevision:remote.revision,userGeneration:source.generation,localDigest,remoteDigest});
  }else{
    let stage=await readWholeMeta<WholeIncoming>(db,'wholeIncoming',connection);
    if(stage?.revision!==remote.revision)stage=undefined;
    for(let i=0;!stage?.complete&&i<maxPages;i++){
      await guards.assertCurrent();guards.step?.('pull');progress(guards,'comparing','クラウドのデータを読み込み中',downloaded);const page=await transport.whole('read',{p_expected_revision:remote.revision,p_after_key:stage?.afterKey??'',p_limit:200});
      if(page.code==='conflict')return result('more');stage=await stageWholePage(db,connection,remote.revision,stage?.afterKey??'',page);downloaded+=Array.isArray(page.rows)?page.rows.length:0;
      progress(guards,'comparing','クラウドのデータを読み込み中',downloaded);
    }
    if(!stage?.complete)return result('more',0,downloaded);
    incoming=await hydrateChunkChanges(db,await readWholeRows(db,connection,remote.revision),connection,true);
    remoteDigest=await computeWholeRecordDigest(incoming);
    progress(guards,'comparing','クラウドの読み込み完了',incoming.length,incoming.length);
    decision=decideWholeSync({baseline,serverRevision:remote.revision,userGeneration:source.generation,localDigest,remoteDigest,verifiedRecordCursor:await readVerifiedWholeAncestorCursor(db,connection)});
  }
  // Logical equality deliberately ignores wire chunks. Their guard/garbage
  // still needs an acknowledged transfer, without creating a user edit.
  const maintenance=source.outbox.some(row=>isChunkInternal(row.collection,row.id));
  const mediaRepair=Boolean(baseline&&baseline.serverRevision===remote.revision&&baseline.userGeneration===source.generation&&remoteDigest===baseline.digest&&source.outbox.length&&source.outbox.every(row=>row.collection==='questionImages'&&row.raw!==null));
  if(mediaRepair)decision='upload';
  const replaceEqualWire=decision==='same'&&maintenance&&baseline?.serverRevision!==remote.revision;
  if(decision==='same'&&maintenance)decision='upload';
  let selected:'local'|'remote'|undefined;
  if(priority)decision='conflict';
  if(decision==='conflict'){
    const shown:WholeConflict={version:1,connection,revision:remote.revision,generation:source.generation,localDigest,remoteDigest,device:remote.device,savedAt:remote.savedAt,localSavedAt:source.snapshot.state.savedAt,localDevice:guards.device,local:summarizeWholeRows(localRows),remote:summarizeWholeRows(incoming??[])};
    if(priority){selected=priority;await putWholeMeta(db,'wholeConflict',{...shown,choice:priority,preferSelected:true});}
    else if(prior&&JSON.stringify({...prior,choice:undefined,preferSelected:undefined})===JSON.stringify(shown))selected=prior.choice;
    else await putWholeMeta(db,'wholeConflict',shown);
    if(!selected)return {status:'conflict',conflicts:[],uploaded:0,downloaded};
  }
  if(preparationError&&selected!=='remote')throw preparationError;
  const preferSelected=Boolean(selected&&priority&&guards.archiveOriginals);
  let verifiedCloud:FileBackup|undefined,verifiedLocal:FileBackup|undefined;
  let preservedOriginals:PreservedSyncOriginals|undefined;
  const offerChoice=async(error:unknown)=>{
    const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
    if(!selected&&incoming&&guards.archiveOriginals&&code==='invalid_response'){
      await guards.assertCurrent();
      await putWholeMeta(db,'wholeConflict',{version:1,connection,revision:remote.revision,generation:source.generation,localDigest,remoteDigest,device:remote.device,savedAt:remote.savedAt,localSavedAt:source.snapshot.state.savedAt,localDevice:guards.device,local:summarizeWholeRows(localRows),remote:summarizeWholeRows(incoming)});
    }
  };
  const incomingFile=async():Promise<FileBackup>=>{
    if(!incoming)throw new SyncProtocolError('invalid_response','クラウドの受信原本がありません。データは保持しています。');
    try {
      await guards.prepareMedia?.();await guards.assertCurrent();
      const file=await guards.incoming(incoming,{allowMissingImages:preferSelected&&selected==='remote'||Boolean(legacyImages?.images.length)});
      if(file.backupManifest.completeness==='partial'&&!(preferSelected&&selected==='remote')&&!acceptsLegacyImages(missingSyncImages(file),legacyImages))throw new SyncProtocolError('invalid_response','クラウドに未確認の画像参照があります。使うデータを選んでください。');
      return file;
    }
    catch(error){
      if(error instanceof SyncInterruptedError)throw error;
      const failure=error&&typeof error==='object'&&'code' in error?error:new SyncProtocolError('invalid_response','クラウドの画像・教材を完全に退避できないため、同期を中止しました。両方の原本を保持しています。'+(error instanceof Error?' '+error.message:''));
      await offerChoice(failure);throw failure;
    }
  };
  const assertSource=()=>withCoordinatedDataRead(['app','notes'],async()=>{
    const current=await readAppRecordSnapshot(db);
    if(current?.state.commitId!==source.snapshot.state.commitId||await readUserEditGeneration(db)!==source.generation)throw new SyncProtocolError('local_changed','自動バックアップ中にこの端末の内容が変わりました。最新の内容で再試行します。');
  },{requireCrossContext:true});
  if(preferSelected){
    guards.step?.('backup');
    // Explicit selection also accepts legacy local-only image references.
    // Keep every ID and archive the exact selected records before proceeding.
    if(selected==='remote')verifiedCloud=await incomingFile();
    else {try{verifiedLocal=await exportFileBackup({recovery:true});}catch(error){if(!mayRescue(error))throw error;throw new SyncProtocolError('invalid_response','この端末の画像・教材を完全に退避できません。別の側を選び直してください。');}}
    const selectedFile=selected==='remote'?verifiedCloud!:verifiedLocal!;
    const validation=await validateFileBackup(selectedFile);
    const imageOnly=isImageOptionalSyncFile(selectedFile);
    if(!validation.ok||selectedFile.backupManifest.completeness!=='complete'&&!imageOnly)throw new SyncProtocolError('invalid_response',selected==='remote'?'クラウドの参照関係を確認できません。端末と受信原本を保持しています。':'この端末の画像・教材を完全に退避できません。別の側を選び直してください。');
    await guards.assertCurrent();
    let otherCopy:SavedBackup;
    try{
      const otherFile=selected==='remote'?await exportFileBackup():await incomingFile();
      const otherValidation=await validateFileBackup(otherFile);if(!otherValidation.ok||otherFile.backupManifest.completeness!=='complete')throw new Error('もう一方の完全コピーを作成できません。');
      if(selected==='remote')verifiedLocal=otherFile;else verifiedCloud=otherFile;
      progress(guards,'backup','同期前のバックアップを保存中',0,2);
      otherCopy=await saveBackupPayload(otherFile,'before-sync');
    }catch(error){
      if(!mayRescue(error))throw error;
      await guards.assertCurrent();otherCopy=await guards.archiveOriginals!(selected==='remote'?'local':'remote',selected==='remote'?localRows:incoming!);
      try{guards.notice?.('読み出せる原本を自動で退避しました。');}catch{/* Informational only. */}
    }
    await guards.assertCurrent();progress(guards,'backup','同期前のバックアップを保存中',1,2);
    const selectedOriginal=imageOnly?await guards.archiveOriginals!(selected!,selected==='remote'?incoming!:localRows):undefined;
    await guards.assertCurrent();
    const selectedCopy=await saveBackupPayload(selectedFile,'before-sync');await guards.assertCurrent();
    const otherRead=await getSavedBackup(otherCopy.id),selectedRead=await getSavedBackup(selectedCopy.id);
    await guards.assertCurrent();
    if(otherRead?.raw!==otherCopy.raw||selectedRead?.raw!==selectedCopy.raw)throw new SyncProtocolError('local_persistence_failed','同期前の原本バックアップを保存できませんでした。');
    if(selectedOriginal&&(await getSavedBackup(selectedOriginal.id))?.raw!==selectedOriginal.raw)throw new SyncProtocolError('local_persistence_failed','選択した原本を保存できませんでした。');
    await assertSource();progress(guards,'backup','同期前のバックアップを保存中',2,2);
    if(selected==='remote')preservedOriginals={backupId:otherCopy.id,raw:otherCopy.raw,commitId:source.snapshot.state.commitId,connection,...(selectedOriginal?{selectedImages:{backupId:selectedCopy.id,raw:selectedCopy.raw,originalId:selectedOriginal.id,originalRaw:selectedOriginal.raw}}:{})};
    if(imageOnly)try{guards.notice?.(`画像${missingSyncImages(selectedFile).length}件は未取得ですが、教材・履歴は同期しました。`);}catch{/* Informational only. */}
  }
  if(!remote.enabled){
    guards.step?.('backup');
    if(!preferSelected){
      verifiedCloud=await incomingFile();
      await guards.assertCurrent();
      try { verifiedLocal=await exportFileBackup(); }
      catch(error){throw new SyncProtocolError('local_persistence_failed','この端末の画像・教材を完全に退避できないため、同期を中止しました。両方の原本を保持しています。'+(error instanceof Error?' '+error.message:''));}
      await guards.assertCurrent();
      try {
        progress(guards,'backup','同期前のバックアップを保存中',0,2);
        const localCopy=await saveBackupPayload(verifiedLocal,'before-sync');await guards.assertCurrent();progress(guards,'backup','同期前のバックアップを保存中',1,2);
        const cloudCopy=await saveBackupPayload(verifiedCloud,'before-sync');await guards.assertCurrent();
        const localRead=await getSavedBackup(localCopy.id);await guards.assertCurrent();
        const cloudRead=await getSavedBackup(cloudCopy.id);await guards.assertCurrent();
        if(localRead?.raw!==localCopy.raw||cloudRead?.raw!==cloudCopy.raw)throw new Error('自動バックアップの読み戻しが一致しません。');
      }catch(error){if(error instanceof SyncInterruptedError)throw error;throw new SyncProtocolError('local_persistence_failed','同期前の自動バックアップを保存できませんでした。同期先と両方の原本を保持しています。');}
      await assertSource();progress(guards,'backup','同期前のバックアップを保存中',2,2);
    }
    await guards.assertCurrent();
    const latest=head(await transport.whole('status'));if(latest.revision!==remote.revision)return result('more');
    const opened=await transport.whole('open',{p_expected_revision:remote.revision});if(opened.code==='conflict')return result('more');requireOk(opened);
    remote=head(await transport.whole('status'));if(remote.revision!==latest.revision)return result('more');
  }
  if(decision==='same'){
    const latest=head(await transport.whole('status'));if(latest.revision!==remote.revision)return result('more');
    await acknowledgeIdenticalWhole(db,{version:1,connection,serverRevision:remote.revision,userGeneration:source.generation,digest:localDigest});return result('done',0,downloaded);
  }
  if(decision==='download'||selected==='remote'){
    if(!incoming)throw new SyncProtocolError('invalid_response','全体の受信原本がありません。');
    const file=verifiedCloud??await incomingFile();await guards.assertCurrent();
    // The existing apply guard deliberately blocks network work while its own
    // commit overlay is active. Recheck the immutable head before entering it;
    // preserve this revision as the ancestor if another device then advances it.
    const latest=head(await transport.whole('status'));if(latest.revision!==remote.revision){if(preferSelected)return result('more');throw new SyncProtocolError('remote_changed','選択後にクラウドが変わりました。両方を保持して再確認します。');}
    progress(guards,'applying','選んだデータを端末に反映中');
    const applied=await guards.apply(async options=>{
      if(options?.preserveLiveData)return {applied:false as const,deferred:true as const,commitId:source.snapshot.state.commitId,pushBlocked:true};
      const committed=await applyWholeSyncFile(file,source.generation,tx=>{
        queueWholeReplacement(tx,incoming!,{version:1,connection,serverRevision:remote.revision,userGeneration:source.generation,digest:remoteDigest});
        if(preferSelected||legacyImages)queueLegacyImageSync(tx,connection,missingSyncImages(file));
      },decision==='conflict',preservedOriginals,!preferSelected?legacyImages:undefined);
      if(!committed.ok){
        if(committed.committed)throw new Error(committed.error);
        if(preferSelected&&(committed.error.includes('端末の内容が変更')||committed.error.includes('現在の端末データが一致しません')))throw new SyncProtocolError('local_changed','同期中に端末の内容が変わりました。選んだ側で再試行します。');
        throw new SyncProtocolError('local_persistence_failed',committed.error);
      }
      const snapshot=await readAppRecordSnapshot(db);if(!snapshot)throw new Error('全体保存後の確認に失敗しました。');
      return {applied:true as const,data:JSON.parse(file.localStorage['quiz-make-app-data-v1']),cursor:remote.revision,changed:Math.max(1,incoming!.length),commitId:snapshot.state.commitId};
    });
    return result(applied?.applied?'done':'deferred',0,downloaded);
  }
  let archive:((tx:IDBTransaction)=>void)|undefined;
  if(selected==='local'&&!preferSelected){
    if(!incoming)throw new SyncProtocolError('invalid_response','保管するクラウド原本がありません。');
    guards.step?.('backup');const cloud=verifiedCloud??await incomingFile(),local=verifiedLocal??await exportFileBackup();await guards.assertCurrent();
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
  const legacyArchive=archive;
  if(preferSelected&&verifiedLocal)archive=tx=>{legacyArchive?.(tx);queueLegacyImageSync(tx,connection,missingSyncImages(verifiedLocal!));};
  else if(mediaRepair&&legacyImages)archive=tx=>{legacyArchive?.(tx);queueLegacyImageSync(tx,connection,legacyImages.images.filter(image=>!source.snapshot.records.get(appRecordKey('questionImages',image.id))?.raw));};
  await guards.assertCurrent();await freezeWholeUpload(db,next,source.snapshot.state.commitId,archive);
  const sent=await sendFrozenWhole(db,transport,guards,next);return finishUpload(next,sent,downloaded);
}
