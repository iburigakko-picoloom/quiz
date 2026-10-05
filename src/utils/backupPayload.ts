import { accountLocalStorage as localStorage } from './accountStorage';
import { exportQuizMakeData, exportQuizMakeRecoveryData, validateHydratedSyncPayload, isQuizMakeStorageKey, waitForLocalPersistence, type SyncPayload, type SyncResult } from './syncService';
import { openAppDb, loadAppDataAsync, establishCurrentAppDataAuthority } from '../storage';
import { withCoordinatedDataRead, withCoordinatedDataMutation, assertDataEpochSnapshotCurrent } from './dataCoordination';
import { getNoteBackupIssues, CATEGORY_NOTES_MANIFEST_KEY, CATEGORY_NOTES_RECOVERY_REQUIRED_KEY } from './noteStorage';
import { materialFileEntry, validMaterialRecord, type MaterialIndex } from './materialModel';
import { openQuestionImageRecordDb, readQuestionImages, describeQuestionImage, validQuestionImageDescriptor, questionImageMetadataKey, type StoredQuestionImage, type QuestionImageDescriptor } from './questionImageRecords';
import { verifyQuestionImageBlob } from './questionImageCloud';
import { saveAppRecords, readAppRecordSnapshot, appRecordKey } from './appRecordStorage';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import { prepareLearningValue, queueLearningValue, queueLearningFence, readLearningValues } from './learningValueStorage';
import { isLearningStorageKey } from './learningStorageKeys';
import { replayLocalStorageProjections } from './localStorageRecords';
import { isChunkInternal } from './recordChunkFormat';
import { advanceLocalDataRevision } from './localDataRevision';
import type { AppData } from '../types';
import { prepareWholeRecovery } from './wholeRecovery';
import { NOTES_EVENT } from './weaknessNotes';
import { PLAN_EVENT } from './studyPlanStorage';

export type FileBackup = SyncPayload & {
  backupManifest: { schema:1; completeness:'complete'|'partial'; issues:string[]; questionCount:number; noteCount:number; imageCount:number; contentDigest:string };
  questionImageFiles: Array<{descriptor:QuestionImageDescriptor;dataUrl:string}>;
};
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const sorted=(value:Record<string,string>)=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
const digest=(payload:SyncPayload,images:FileBackup['questionImageFiles'])=>hash(JSON.stringify({localStorage:sorted(payload.localStorage),indexedDbNotes:sorted(payload.indexedDbNotes??{}),images:[...images].sort((a,b)=>a.descriptor.id.localeCompare(b.descriptor.id)).map(image=>image.descriptor)}));
function imageOwners(data:AppData):Map<string,string>{
  const owners=new Map<string,string>();
  for(const question of data.questions)for(const id of new Set([...(question.questionImageIds??[]),...(question.detailedAnswer?.imageIds??[])])){
    if(owners.has(id)&&owners.get(id)!==question.id)throw new Error('同じ画像IDが異なる問題から参照されています。原本を残して画像を確認してください。');
    owners.set(id,question.id);
  }
  return owners;
}
function materialIssues(payload:SyncPayload,data:AppData):string[]{
  const notes={...payload.localStorage,...payload.indexedDbNotes},owners=new Map<string,MaterialIndex>(),issues:string[]=[];
  for(const [key,raw] of Object.entries(notes))if(key.endsWith(':__materials_v1')){
    try{const index=JSON.parse(raw) as MaterialIndex;if(index.kind!=='quiz-material-index'||!validMaterialRecord(index as unknown as Record<string,unknown>))throw new Error();
      for(const material of index.materials){owners.set(material.id,index);if(material.pages.some(page=>page.kind==='pdf')){
        const file=materialFileEntry(`quizMake:notes:${index.problemSetId}:__material_pdf_${material.id}`,notes[`quizMake:notes:${index.problemSetId}:__material_pdf_${material.id}`]??'');
        if(file?.kind!=='quiz-material-file')issues.push(`PDF本体未収録: ${material.title}`);
      }}
    }catch{issues.push(`資料一覧未確認: ${key}`);}
  }
  for(const question of data.questions)for(const ref of question.materialReferences??[]){
    const index=owners.get(ref.materialId);
    if(!index?.materials.some(material=>material.id===ref.materialId&&material.pages.some(page=>page.id===ref.pageId)))issues.push(`参照資料未収録: ${question.id}`);
  }
  return issues;
}
async function encode(blob:Blob):Promise<string>{
  const bytes=new Uint8Array(await blob.arrayBuffer());let text='';
  for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return `data:${blob.type};base64,${btoa(text)}`;
}
async function decode(row:FileBackup['questionImageFiles'][number]):Promise<StoredQuestionImage>{
  if(!validQuestionImageDescriptor(row.descriptor)||typeof row.dataUrl!=='string')throw new Error('画像の保存情報を確認できません。');
  const prefix=`data:${row.descriptor.type};base64,`;
  if(!row.dataUrl.startsWith(prefix))throw new Error('画像形式が保存情報と一致しません。');
  const encoded=row.dataUrl.slice(prefix.length);
  if(encoded.length!==4*Math.ceil(row.descriptor.size/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('画像の容量または形式が不正です。');
  const text=atob(encoded),bytes=Uint8Array.from(text,letter=>letter.charCodeAt(0)),blob=new Blob([bytes],{type:row.descriptor.type});
  if(!await verifyQuestionImageBlob(blob,row.descriptor))throw new Error('画像本体のハッシュが保存情報と一致しません。');
  return {id:row.descriptor.id,questionId:row.descriptor.questionId,name:row.descriptor.name,type:row.descriptor.type,addedAt:row.descriptor.addedAt,blob};
}
export async function exportFileBackup(options:{recovery?:boolean}={}):Promise<FileBackup>{
  let payload:SyncPayload,issues:string[]=[];
  try{payload=await exportQuizMakeData();}catch(error){if(!options.recovery)throw error;payload=await exportQuizMakeRecoveryData();issues.push('一部の保存データを完全には検証できていません。');}
  return withCoordinatedDataRead(['app','notes'],async()=>{
    assertDataEpochSnapshotCurrent(payload,['app','notes']);
    const data=JSON.parse(payload.localStorage['quiz-make-app-data-v1']) as AppData,files:FileBackup['questionImageFiles']=[];
    issues.push(...getNoteBackupIssues(payload.indexedDbNotes??{}),...materialIssues(payload,data));
    const db=await openQuestionImageRecordDb(),snapshot=await readAppRecordSnapshot(db);
    for(const [id,owner] of imageOwners(data)){
      const image=(await readQuestionImages(owner,[id]))[0];
      const raw=snapshot?.records.get(appRecordKey('questionImages',id))?.raw;
      const descriptor=raw?JSON.parse(raw) as QuestionImageDescriptor:undefined;
      if(!image||!descriptor||!validQuestionImageDescriptor(descriptor)||descriptor.questionId!==owner||!await verifyQuestionImageBlob(image.blob,descriptor)){issues.push(`画像本体未確認: ${id}`);continue;}
      files.push({descriptor:await describeQuestionImage(image),dataUrl:await encode(image.blob)});
    }
    if(issues.length&&!options.recovery)throw new Error('完全な復元コピーを作成できません。'+issues.join(' '));
    const result:FileBackup={...payload,questionImageFiles:files,backupManifest:{schema:1,completeness:issues.length?'partial':'complete',issues:[...new Set(issues)],questionCount:data.questions.length,noteCount:Object.keys(payload.indexedDbNotes??{}).length,imageCount:files.length,contentDigest:await digest(payload,files)}};
    assertDataEpochSnapshotCurrent(payload,['app','notes']);return result;
  },{requireCrossContext:true});
}
export async function validateFileBackup(value:unknown):Promise<SyncResult<{payload:FileBackup;images:StoredQuestionImage[]}>>{
  try{
    const input=value as FileBackup;
    if(!input?.backupManifest||input.backupManifest.schema!==1||!['complete','partial'].includes(input.backupManifest.completeness)||!Array.isArray(input.backupManifest.issues)||input.backupManifest.issues.some(issue=>typeof issue!=='string')||!Array.isArray(input.questionImageFiles))throw new Error('復元コピーの収録一覧を確認できません。');
    // This versioned complete file covers the existing 128 MiB record dataset.
    // Legacy Snapshot wire stays at 32 MiB; PDF/image limits stay at 50 MiB.
    const payload={version:input.version,updatedAt:input.updatedAt,localStorage:input.localStorage,indexedDbNotes:input.indexedDbNotes};
    const validation=await validateHydratedSyncPayload(payload,{recordRecovery:true});if(!validation.ok)return validation;
    const data=JSON.parse(validation.value.localStorage['quiz-make-app-data-v1']) as AppData,owners=imageOwners(data),images:StoredQuestionImage[]=[],seen=new Set<string>();
    for(const file of input.questionImageFiles){const image=await decode(file);if(seen.has(image.id)||owners.get(image.id)!==image.questionId)throw new Error('画像の参照先またはIDが一致しません。');seen.add(image.id);images.push(image);}
    if(input.backupManifest.questionCount!==data.questions.length||input.backupManifest.noteCount!==Object.keys(validation.value.indexedDbNotes??{}).length||input.backupManifest.imageCount!==images.length||input.backupManifest.contentDigest!==await digest(validation.value,input.questionImageFiles))throw new Error('復元コピーの収録数またはハッシュが一致しません。');
    if(input.backupManifest.completeness==='complete'&&(input.backupManifest.issues.length||seen.size!==owners.size||materialIssues(validation.value,data).length))throw new Error('完全な復元に必要な画像・PDF・資料が不足しています。');
    return {ok:true,value:{payload:{...validation.value,backupManifest:input.backupManifest,questionImageFiles:input.questionImageFiles},images}};
  }catch(error){return {ok:false,code:'invalid',error:error instanceof Error?error.message:'復元コピーを検証できません。'};}
}

/** New complete files use the existing shared database transaction. Old formats
 * keep their documented legacy restore route and cannot claim media completeness. */
export async function restoreFileBackup(payload:FileBackup):Promise<SyncResult<number>&{committed?:boolean}>{
  const checked=await validateFileBackup(payload);if(!checked.ok)return checked;
  if(payload.backupManifest.completeness!=='complete')return {ok:false,code:'invalid',error:'このファイルは部分的な救出コピーです。欠落一覧を確認し、完全コピーとして上書き復元しないでください。'};
  const ready=await waitForLocalPersistence();if(!ready.ok)return ready;
  let committed=false;
  try{return await withCoordinatedDataMutation(['app','notes'],async()=>{
    const db=await openAppDb();
    // A verified current copy is mandatory; it remains on this device. Reading
    // under the already-held lock avoids a nested export lock.
    const previous=await loadAppDataAsync({coordinationLockHeld:true});
    const snapshot=await readAppRecordSnapshot(db);if(!snapshot)throw new Error('現在の保存状態を確認できません。');
    const target=JSON.parse(checked.value.payload.localStorage['quiz-make-app-data-v1']) as AppData;
    const notes=checked.value.payload.indexedDbNotes??{},settings=Object.fromEntries(Object.entries(checked.value.payload.localStorage).filter(([key])=>key!=='quiz-make-app-data-v1'&&!key.startsWith('quizMake:notes:')&&!key.startsWith('quizMake:image:')));
    const existingSettings=new Set<string>(),existingImageKeys=new Set<string>();for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith('quizMake:image:'))existingImageKeys.add(key);if(key&&isQuizMakeStorageKey(key)&&key!=='quiz-make-app-data-v1'&&!key.startsWith('quizMake:notes:')&&!key.startsWith('quizMake:image:')&&!isChunkInternal('localStorage',key))existingSettings.add(key);}
    const previousLearning=await readLearningValues(db);
    const allSettings=new Set([...existingSettings,...Object.keys(settings)]),learning=new Map(await Promise.all([...allSettings].filter(isLearningStorageKey).map(async key=>[key,{...await prepareLearningValue(key,settings[key]??null),...(previousLearning.get(key)?.nativeCleanup?{nativeCleanup:previousLearning.get(key)!.nativeCleanup}:{})}] as const)));
    const read=db.transaction(['categoryNotes','questionImageBlobs']),oldNotes=read.objectStore('categoryNotes').getAll(),oldNoteKeys=read.objectStore('categoryNotes').getAllKeys(),oldImages=read.objectStore('questionImageBlobs').getAll();await new Promise<void>((r,j)=>{read.oncomplete=()=>r();read.onabort=()=>j(read.error);});
    const previousNotes=Object.fromEntries(oldNoteKeys.result.map((key,index)=>[String(key),oldNotes.result[index]]));
    if(getNoteBackupIssues(previousNotes).length)throw new Error('現在のノートを完全に退避できないため、復元を中止しました。');
    const previousOwners=imageOwners(previous),previousImages=oldImages.result as StoredQuestionImage[];
    for(const [id,owner] of previousOwners){const image=previousImages.find(image=>image.id===id&&image.questionId===owner),raw=snapshot.records.get(appRecordKey('questionImages',id))?.raw;if(!image||!raw||!await verifyQuestionImageBlob(image.blob,JSON.parse(raw)))throw new Error('現在の画像を完全に退避できないため、復元を中止しました。');}
    const previousSettings=Object.fromEntries([...existingSettings].map(key=>[key,localStorage.getItem(key)!]));
    if(materialIssues({version:1,updatedAt:new Date().toISOString(),localStorage:{...previousSettings,'quiz-make-app-data-v1':JSON.stringify(previous)},indexedDbNotes:previousNotes},previous).length)throw new Error('現在のPDF・参照資料を完全に退避できないため、復元を中止しました。');
    const archiveImages:FileBackup['questionImageFiles']=[];
    for(const image of previousImages.filter(image=>previousOwners.has(image.id)))archiveImages.push({descriptor:await describeQuestionImage(image),dataUrl:await encode(image.blob)});
    const archivePayload:SyncPayload={version:1,updatedAt:new Date().toISOString(),localStorage:{...previousSettings,'quiz-make-app-data-v1':JSON.stringify(previous)},indexedDbNotes:previousNotes};
    const archive:FileBackup={...archivePayload,questionImageFiles:archiveImages,backupManifest:{schema:1,completeness:'complete',issues:[],questionCount:previous.questions.length,noteCount:Object.keys(previousNotes).length,imageCount:archiveImages.length,contentDigest:await digest(archivePayload,archiveImages)}};
    const queueArchive=await prepareWholeRecovery(db,archive,'before-restore',new Blob([JSON.stringify(payload)]).size);
    await saveAppRecords(db,target,new Date().toISOString(),undefined,[],tx=>{
      queueArchive(tx);
      for(const key of new Set([...Object.keys(previousNotes),...Object.keys(notes)])){
        if(notes[key]===undefined)tx.objectStore('categoryNotes').delete(key);else tx.objectStore('categoryNotes').put(notes[key],key);
        queueAuxiliaryRecordWrite(tx,'indexedDbNotes',key,notes[key]??null);
      }
      if(learning.size)queueLearningFence(tx);
      for(const key of allSettings){const value=learning.get(key);if(value)queueLearningValue(tx,value);else tx.objectStore('localProjections').put(settings[key]??null,key);queueAuxiliaryRecordWrite(tx,'localStorage',key,settings[key]??null);}
      tx.objectStore('questionImageBlobs').clear();
      for(const key of existingImageKeys)tx.objectStore('localProjections').put(null,key);
      const incoming=new Set(checked.value.images.map(image=>image.id));
      for(const image of previousImages)if(!incoming.has(image.id))queueAuxiliaryRecordWrite(tx,'questionImages',image.id,null);
      for(const image of checked.value.images){tx.objectStore('questionImageBlobs').put(image,image.id);const descriptor=payload.questionImageFiles.find(file=>file.descriptor.id===image.id)!.descriptor;queueAuxiliaryRecordWrite(tx,'questionImages',image.id,JSON.stringify(descriptor));tx.objectStore('localProjections').put(JSON.stringify(descriptor),questionImageMetadataKey(image.id));}
      tx.objectStore('localProjections').put(JSON.stringify({version:1,keys:Object.keys(notes).sort()}),CATEGORY_NOTES_MANIFEST_KEY);
      tx.objectStore('localProjections').put(null,CATEGORY_NOTES_RECOVERY_REQUIRED_KEY);
    });
    committed=true;await replayLocalStorageProjections(db);
    if(!establishCurrentAppDataAuthority())throw new Error('復元データは保存しましたが、表示の保護状態を更新できません。再読み込みしてください。');
    advanceLocalDataRevision();window.dispatchEvent(new Event(PLAN_EVENT));window.dispatchEvent(new Event(NOTES_EVENT));return {ok:true,value:target.questions.length};
  },{requireCrossContext:true});}catch(error){return {ok:false,committed,code:'local_persistence_failed',error:error instanceof Error?error.message:'復元を保存できません。現在のコピーは保持しています。'};}
}
