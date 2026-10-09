import type { AppData } from '../types';
import type { SyncPayload } from './syncService';
import { materialFileEntry, validMaterialRecord, type MaterialIndex } from './materialModel';
import { SyncProtocolError } from './syncInterruption';

export type SyncDataCode = 'pdf_download' | 'pdf_missing' | 'pdf_integrity' | 'material_reference' | 'image_missing' | 'image_reference' | 'note_integrity' | 'backup_integrity' | 'storage_capacity' | 'memory_limit';
export type SyncFailureDetails = {
  function: 'materialReferences' | 'hydrateMaterialDownload' | 'materialDownload' | 'createFileBackup' | 'validateFileBackup' | 'buildWholeIncomingFile';
  stage: 'material_references' | 'pdf_download' | 'pdf_integrity' | 'backup_build' | 'backup_validate';
  cause?: 'network' | 'timeout' | 'http' | 'size' | 'sha256' | 'missing' | 'reference' | 'manifest' | 'quota' | 'memory' | 'format';
  total?: number; completed?: number; downloaded?: number; cacheReused?: number; localReused?: number; httpStatus?: number; attempts?: number;
  pdfTotal?:number;pdfCompleted?:number;
  referenceIssues?: MaterialReferenceIssue[];
  issueCount?: number;
};
export type MaterialReferenceIssue = {
  reason: 'invalid_index' | 'index_identity' | 'missing_owner' | 'missing_material' | 'missing_page' | 'ambiguous_material';
  questionId?: string; problemSetId?: string; materialId?: string; pageId?: string; ownerSetIds?: string[];
};
export const integrityCodes: readonly string[] = ['pdf_missing','pdf_integrity','material_reference','image_missing','image_reference','note_integrity','backup_integrity'];
export class SyncDataError extends SyncProtocolError {
  readonly diagnostic: SyncFailureDetails;
  readonly retryable: boolean;
  constructor(code: SyncDataCode | 'authentication_required' | 'permission_denied', message: string, diagnostic: SyncFailureDetails, retryable = false) {
    super(code, message); this.name = 'SyncDataError'; this.diagnostic = diagnostic; this.retryable = retryable;
  }
}
export function syncDataFailure(error: unknown, fn: SyncFailureDetails['function'], stage: SyncFailureDetails['stage']): SyncDataError {
  if(error instanceof SyncDataError)return error;
  const name=error instanceof Error?error.name:'';
  if(name==='QuotaExceededError')return new SyncDataError('storage_capacity','端末への保存容量が不足しています。',{function:fn,stage,cause:'quota'});
  if(error instanceof RangeError)return new SyncDataError('memory_limit','同期データを処理するメモリが不足しています。',{function:fn,stage,cause:'memory'});
  return new SyncDataError('backup_integrity','バックアップの内容を検証できませんでした。',{function:fn,stage,cause:'format'});
}

/** Validate identities before downloading bodies. Never guess or remove a reference. */
export function assertMaterialIntegrity(payload: Pick<SyncPayload,'localStorage'|'indexedDbNotes'>, data: AppData, hydrated: boolean): void {
  for(const [key,raw] of Object.entries(payload.localStorage))if(key.endsWith(':__materials_v1')&&payload.indexedDbNotes?.[key]!==undefined&&payload.indexedDbNotes[key]!==raw){
    throw new SyncDataError('material_reference','資料の紐づけ情報に不備があります。',{function:'materialReferences',stage:'material_references',cause:'reference',referenceIssues:[{reason:'index_identity'}],issueCount:1});
  }
  const notes={...payload.localStorage,...payload.indexedDbNotes};
  const sets=new Set(data.problemSets.map(set=>set.id)), materials=new Map<string,Array<{owner:string;pages:Set<string>}>>();
  const fail=(code:SyncDataCode,message:string,cause:SyncFailureDetails['cause'],issue?:MaterialReferenceIssue)=>{throw new SyncDataError(code,message,{function:'materialReferences',stage:'material_references',cause,...(issue?{referenceIssues:[issue],issueCount:1}:{})});};
  for(const [key,raw] of Object.entries(notes))if(key.endsWith(':__materials_v1')){
    let index: MaterialIndex;
    try{index=JSON.parse(raw);if(index.kind!=='quiz-material-index'||!validMaterialRecord(index as unknown as Record<string,unknown>))throw new Error();}
    catch{fail('material_reference','資料の紐づけ情報に不備があります。','format',{reason:'invalid_index'});continue;}
    if(key!==`quizMake:notes:${index.problemSetId}:__materials_v1`)fail('material_reference','資料の紐づけ情報に不備があります。','reference',{reason:'index_identity',problemSetId:index.problemSetId});
    if(!sets.has(index.problemSetId))fail('material_reference','資料の紐づけ情報に不備があります。','reference',{reason:'missing_owner',problemSetId:index.problemSetId});
    for(const material of index.materials){
      const owners=materials.get(material.id)??[];
      owners.push({owner:index.problemSetId,pages:new Set(material.pages.map(page=>page.id))});materials.set(material.id,owners);
    }
    for(const material of index.materials)if(material.pages.some(page=>page.kind==='pdf')){
      const fileKey=`quizMake:notes:${index.problemSetId}:__material_pdf_${material.id}`,rawFile=notes[fileKey];
      if(!rawFile)fail('pdf_missing','資料一覧にあるPDF本体が見つかりません。','missing');
      const file=materialFileEntry(fileKey,rawFile);
      if(!file)fail('pdf_integrity','PDFの内容を検証できませんでした。','format');
      if(hydrated&&file!.kind!=='quiz-material-file')fail('pdf_missing','PDF本体の受信が完了していません。','missing');
    }
  }
  let references=0,missing=0;
  const issues:MaterialReferenceIssue[]=[];
  for(const question of data.questions)for(const ref of question.materialReferences??[]){
    references++;
    // The reading/linking UI permits another live set's material. IDs carry no
    // owner field, so require exactly one owner rather than guessing by set.
    const owners=materials.get(ref.materialId)??[];
    const reason=!owners.length?'missing_material':owners.length>1?'ambiguous_material':!owners[0].pages.has(ref.pageId)?'missing_page':undefined;
    if(reason){missing++;if(issues.length<10)issues.push({reason,questionId:question.id,problemSetId:question.setId,materialId:ref.materialId,pageId:ref.pageId,...(owners.length?{ownerSetIds:owners.slice(0,10).map(owner=>owner.owner)}:{})});}
  }
  if(missing)throw new SyncDataError('material_reference','資料の紐づけ情報に不備があります。',{function:'materialReferences',stage:'material_references',cause:'reference',total:references,completed:references-missing,referenceIssues:issues,issueCount:missing});
}
