import type {PublicationPayload} from './publicationPayload';
import type {CloudPublishResult} from './cloudService';
export type PublicationRpcName='quiz_publish_begin'|'quiz_publish_part'|'quiz_publish_finish'|'quiz_publish_status'|'quiz_publish_cancel';
export type PublicationTransport=(name:PublicationRpcName,params:Record<string,unknown>)=>Promise<unknown>;
export type PublicationProgress={uploaded:number;total:number;phase:'preparing'|'uploading'|'committing'|'completed'};
export class PublicationError extends Error {
  readonly code:string;readonly retryable:boolean;readonly technical?:string;
  constructor(message:string,code:string,retryable:boolean,technical?:string){super(message);this.code=code;this.retryable=retryable;this.technical=technical;}
}
export function publicationFailure(code:string,message=''):PublicationError {
  const value=(code+' '+message).toLowerCase();
  if(value.includes('57014')||value.includes('statement timeout'))return new PublicationError('公開処理に時間がかかりました。保存済みの位置から再試行できます。','timeout',true,message);
  if(value.includes('network')||value.includes('fetch')||value.includes('abort')||value.includes('timeout'))return new PublicationError('通信が途切れました。再試行すると続きから公開します。','network',true,message);
  if(value.includes('publication_busy'))return new PublicationError('同じセットを別の画面で公開中です。完了後に再試行してください。','busy',true,message);
  if(value.includes('publication_payload_too_large')||value.includes('publication_question_too_large'))return new PublicationError('公開データが容量上限を超えています。セットを分割して公開してください。','size',false,message);
  if(value.includes('publication_conflict'))return new PublicationError('公開情報が別の画面で変更されました。公開設定を確認してやり直してください。','conflict',false,message);
  if(value.includes('publication_expired')||value.includes('expired')||value.includes('cancelled'))return new PublicationError('この公開処理は終了しています。公開設定を確認してやり直してください。','expired',false,message);
  if(value.includes('pgrst202')||value.includes('42883')||value.includes('404'))return new PublicationError('公開機能のサーバー更新が必要です。更新後に再試行してください。','unavailable',true,message);
  if(value.includes('not authorized')||value.includes('account')||value.includes('401')||value.includes('403'))return new PublicationError('公開を開始したアカウントでログインしてください。','account',true,message);
  return new PublicationError('公開できませんでした。問題の内容と公開設定を確認してください。','invalid',false,message);
}
export const publicationDigest=async(payload:PublicationPayload)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload))))).map(n=>n.toString(16).padStart(2,'0')).join('');
export function publicationId(){const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=Array.from(bytes).map(n=>n.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export function publicationParts(questions:PublicationPayload['p_questions']) {
  const parts:{start:number;questions:PublicationPayload['p_questions']}[]=[];let current:PublicationPayload['p_questions']=[],bytes=2,start=0;
  for(const question of questions){const size=new TextEncoder().encode(JSON.stringify(question)).byteLength+1;if(size>512*1024)throw publicationFailure('publication_question_too_large');
    if(current.length&&(current.length>=250||bytes+size>512*1024)){parts.push({start,questions:current});start+=current.length;current=[];bytes=2;}current.push(question);bytes+=size;}
  if(current.length)parts.push({start,questions:current});return parts;
}
export function parsePublicationStatus(value:unknown,total:number){
  const row=value as {state?:string;uploaded?:number;total?:number;result?:Record<string,unknown>;is_current?:boolean};
  if(!row||!['uploading','completed','expired','cancelled','missing'].includes(row.state??'')||!Number.isSafeInteger(row.uploaded)||row.uploaded!<0||row.uploaded!>total||(row.total!==undefined&&row.total!==total))throw new PublicationError('公開状態を確認できませんでした。再試行してください。','response',true);
  return row;
}
export function publicationResult(row:ReturnType<typeof parsePublicationStatus>):CloudPublishResult {
  if(row.state!=='completed'||!row.result||typeof row.result.id!=='string'||typeof row.result.share_token!=='string'||typeof row.result.version_id!=='string'||!['public','link','group'].includes(String(row.result.visibility)))throw new PublicationError('公開結果を確認できません。再試行してください。','response',true);
  if(row.is_current!==true)throw new PublicationError('公開後に共有状態が変更されています。現在の公開設定を確認してください。','withdrawn',false);
  return {id:row.result.id,shareToken:row.result.share_token,versionId:row.result.version_id,visibility:row.result.visibility as CloudPublishResult['visibility']};
}
export async function uploadPublication(payload:PublicationPayload,id:string,digest:string,rpc:PublicationTransport,onProgress:(progress:PublicationProgress)=>Promise<void>|void=()=>{}) {
  const total=payload.p_questions.length;const parts=publicationParts(payload.p_questions);
  if(await publicationDigest(payload)!==digest)throw new PublicationError('保存した公開データを確認できません。公開設定を確認してやり直してください。','snapshot',false);
  const request=async(name:PublicationRpcName,args:Record<string,unknown>)=>{
    for(let attempt=0;;attempt++){try{return parsePublicationStatus(await rpc(name,args),total);}catch(reason){const error=reason instanceof PublicationError?reason:publicationFailure('network',reason instanceof Error?reason.message:'');if(!error.retryable||attempt>=1)throw error;}}
  };
  await onProgress({uploaded:0,total,phase:'preparing'});
  let state=await request('quiz_publish_begin',{p_job_id:id,p_set:payload.p_set,p_total:total,p_digest:digest});
  if(state.state==='completed')return publicationResult(state);
  if(state.state!=='uploading')throw publicationFailure(state.state??'invalid');
  await onProgress({uploaded:state.uploaded!,total,phase:'uploading'});
  for(const part of parts){if(part.start+part.questions.length<=state.uploaded!)continue;if(part.start!==state.uploaded)throw new PublicationError('送信位置を確認できません。再試行してください。','position',true);
    state=await request('quiz_publish_part',{p_job_id:id,p_start:part.start,p_questions:part.questions});if(state.state==='completed'){const result=publicationResult(state);await onProgress({uploaded:total,total,phase:'completed'});return result;}if(state.uploaded!==part.start+part.questions.length)throw new PublicationError('送信結果を確認できません。再試行してください。','position',true);
    await onProgress({uploaded:state.uploaded,total,phase:'uploading'});}
  await onProgress({uploaded:total,total,phase:'committing'});state=await request('quiz_publish_finish',{p_job_id:id});
  const result=publicationResult(state);await onProgress({uploaded:total,total,phase:'completed'});return result;
}
