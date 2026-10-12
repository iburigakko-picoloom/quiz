import { getAccountStorageSession } from './accountStorage';
import type { AppData } from '../types';
import type { SyncPayload } from './syncService';
import type { RemoteRecordChange } from './recordSyncPull';
import type { SavedBackup } from './backupRepository';
import { getSavedBackup } from './backupRepository';
import { validateSyncOriginalsFile } from './syncOriginalBackup';
import { wholeRowsPayload } from './wholeSyncIncoming';
import { assertMaterialIntegrity, SyncDataError } from './syncDataIntegrity';
import { materialFileEntry, type MaterialIndex } from './materialModel';
import { hydrateMaterialDownload, type MaterialTransport } from './materialCloud';
import { exportCategoryNotesRaw } from './noteStorage';
import { readCurrentAppRecordSnapshot } from './appRecordStorage';
import { NOTE_RECORD_TRANSACTION_STORES, queueNoteRecordWrite } from './auxiliaryRecordStorage';
import { withCoordinatedDataRead, withCoordinatedDataMutation } from './dataCoordination';
import { SyncProtocolError } from './syncInterruption';

/** Only recover missing identities proven by the same cloud question, set and
 * page. Never replace a live material/PDF, repair a page, or change a question. */
export function planMissingMaterialRepair(local: SyncPayload, remote: SyncPayload): Record<string,string> | null {
  const data = JSON.parse(local.localStorage['quiz-make-app-data-v1']) as AppData;
  try { assertMaterialIntegrity(local,data,false); return null; }
  catch(error) { if(!(error instanceof SyncDataError) || error.code!=='material_reference' || error.diagnostic.referenceIssues?.some(issue=>issue.reason!=='missing_material'))return null; }
  const cloud = JSON.parse(remote.localStorage['quiz-make-app-data-v1']) as AppData;
  assertMaterialIntegrity(remote,cloud,false);
  const localNotes={...local.localStorage,...local.indexedDbNotes},remoteNotes={...remote.localStorage,...remote.indexedDbNotes};
  const indexes = Object.entries(remoteNotes).filter(([key])=>key.endsWith(':__materials_v1')).map(([key,raw])=>({key,index:JSON.parse(raw) as MaterialIndex}));
  const present=new Set(Object.entries(localNotes).filter(([key])=>key.endsWith(':__materials_v1')).flatMap(([,raw])=>(JSON.parse(raw) as MaterialIndex).materials.map(m=>m.id)));
  const sets=new Set(data.problemSets.map(set=>set.id)),cloudQuestions=new Map(cloud.questions.map(q=>[q.id,q]));
  const additions:Record<string,string>={};
  for(const q of data.questions)for(const ref of q.materialReferences??[])if(!present.has(ref.materialId)){
    const owners=indexes.filter(({index})=>index.materials.some(m=>m.id===ref.materialId));
    const peer=cloudQuestions.get(q.id);
    if(owners.length!==1 || peer?.setId!==q.setId || !peer.materialReferences?.some(r=>r.materialId===ref.materialId&&r.pageId===ref.pageId))return null;
    const {key,index}=owners[0],material=index.materials.find(m=>m.id===ref.materialId)!;
    if(!sets.has(index.problemSetId)||!material.pages.some(page=>page.id===ref.pageId))return null;
    const merged=JSON.parse(additions[key]??localNotes[key]??JSON.stringify({...index,materials:[]})) as MaterialIndex;
    if(!merged.materials.some(m=>m.id===material.id))merged.materials.push(material);
    additions[key]=JSON.stringify(merged);
    if(material.pages.some(page=>page.kind==='pdf')){
      const fileKey=`quizMake:notes:${index.problemSetId}:__material_pdf_${material.id}`;
      const raw=remoteNotes[fileKey],file=raw&&materialFileEntry(fileKey,raw);
      // The existing account-bound transport verifies owner, size and SHA-256.
      if(!file||file.kind!=='quiz-material-remote-file'||localNotes[fileKey]!==undefined)return null;
      additions[fileKey]=raw;
    }
  }
  if(!Object.keys(additions).length)return null;
  assertMaterialIntegrity({...local,indexedDbNotes:{...local.indexedDbNotes,...additions}},data,false);
  return additions;
}

export async function repairMissingMaterialReferences(db:IDBDatabase,localRows:RemoteRecordChange[],remoteRows:RemoteRecordChange[],transport:MaterialTransport,guards:{assertCurrent:()=>Promise<void>;assertRemoteCurrent:()=>Promise<void>;archive:()=>Promise<SavedBackup>}):Promise<boolean>{
  const owner=getAccountStorageSession();
  const local=wholeRowsPayload(localRows),remote=wholeRowsPayload(remoteRows);
  const source=await withCoordinatedDataRead(['app','notes'],async()=>{
    await guards.assertCurrent();
    const snapshot=await readCurrentAppRecordSnapshot(db);
    const notes=await exportCategoryNotesRaw({coordinationLockHeld:true});
    local.indexedDbNotes=notes;
    return {snapshot,notes};
  },{requireCrossContext:true});
  if(!source.snapshot)return false;
  const additions=planMissingMaterialRepair(local,remote);if(!additions)return false;
  const hydrated=await hydrateMaterialDownload({version:1,updatedAt:remote.updatedAt,localStorage:{},indexedDbNotes:additions},transport,undefined,undefined,{assertCurrent:guards.assertCurrent});
  await guards.assertRemoteCurrent();await guards.assertCurrent();
  const backup=await guards.archive(),readback=await getSavedBackup(backup.id);
  if(readback?.raw!==backup.raw||!await validateSyncOriginalsFile(JSON.parse(backup.raw))||JSON.parse(backup.raw).localCommitId!==source.snapshot.state.commitId)throw new SyncProtocolError('local_persistence_failed','復旧前の原本バックアップを確認できません。');
  await guards.assertRemoteCurrent();
  await withCoordinatedDataMutation(['app','notes'],async()=>{
    await guards.assertCurrent();
    if((await readCurrentAppRecordSnapshot(db))?.state.commitId!==source.snapshot!.state.commitId)throw new SyncProtocolError('local_changed','資料の復旧中に端末が変更されました。');
    const current=await exportCategoryNotesRaw({coordinationLockHeld:true});
    if(JSON.stringify(current)!==JSON.stringify(source.notes))throw new SyncProtocolError('local_changed','資料の復旧中に端末が変更されました。');
    const tx=db.transaction(NOTE_RECORD_TRANSACTION_STORES,'readwrite');
    const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new SyncProtocolError('local_persistence_failed','資料の復旧を保存できません。'));});
    const witness=tx.objectStore('appRecordMeta').get('state');
    witness.onsuccess=()=>{try{if(owner!==getAccountStorageSession()||witness.result?.commitId!==source.snapshot!.state.commitId)throw new Error('connection_changed');owner?.assertCurrent();}catch{tx.abort();}};
    try{for(const [key,raw] of Object.entries(hydrated.indexedDbNotes??{})){
      if(current[key]!==undefined)tx.objectStore('categoryNoteBackups').put(current[key],key);
      tx.objectStore('categoryNotes').put(raw,key);
      // Keep a small validated remote descriptor on the wire; verified PDF
      // bytes remain a durable cache. Every addition shares the atomic outbox.
      queueNoteRecordWrite(tx,key,materialFileEntry(key,additions[key])?.kind==='quiz-material-remote-file'?additions[key]:raw);
    }}catch(error){tx.abort();await done.catch(()=>{});throw error;}
    await done;
  },{requireCrossContext:true});
  return true;
}
