import type {AppData,ProblemSet,PublicationSource,Question} from '../types';
import type {CloudProblemSet,CloudPublishResult,CloudQuestion} from './cloudService';
import {questionRevision} from './studyPlans';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export const MAX_STORED_SOURCE_MANIFEST_BYTES=400*1024;

/** The fields actually published; private images, annotations and progress stay local. */
export function publishedQuestionContent(q:Question|CloudQuestion):string {
  return JSON.stringify([q.question,q.choices,q.answerIndexes?.length?q.answerIndexes:['answerIndex' in q?q.answerIndex:0],q.answerText,q.explanation,q.detailedExplanation??'',q.sourcePage,q.category,q.difficulty,q.distractors??[],q.shuffleChoices??null]);
}
export const publishedQuestionRevision=(q:Question|CloudQuestion)=>bytesToHex(sha256(new TextEncoder().encode(publishedQuestionContent(q))));
export function publicationSourceFromSnapshot(shared:CloudProblemSet,ownerId:string,localSetId:string,groupIds:readonly string[]=[],inMemory=false):PublicationSource {
  if(shared.ownerId!==ownerId||shared.localSetId!==localSetId||!shared.versionId||!shared.questions?.length)throw new Error('共有元の所有者・公開版を確認できません。');
  const manifest=shared.questions.map(q=>{if(!q.logicalId)throw new Error('共有元の問題IDを確認できません。');return {logicalId:q.logicalId,contentRevision:publishedQuestionRevision(q)};});
  if(new Set(manifest.map(q=>q.logicalId)).size!==manifest.length)throw new Error('共有元の問題IDが重複しています。');
  const retained=inMemory||new TextEncoder().encode(JSON.stringify(manifest)).byteLength<=MAX_STORED_SOURCE_MANIFEST_BYTES;
  return {setId:shared.id,ownerId,versionId:shared.versionId,groupIds:[...new Set(groupIds)].sort(),...(retained?{manifest}:{})};
}
export function applyPublishedSource(data:AppData,localSetId:string,result:CloudPublishResult,source:PublicationSource|undefined,updatedAt:string):AppData {
  const local=data.problemSets.find(s=>s.id===localSetId);if(!local)throw new Error('共有元の教材が削除されています。教材を再作成せず、共有状態を確認してください。');
  if(source&&source.setId!==result.id)throw new Error('共有元の公開IDを確認できません。');
  // Destinations in these publication flows are additive. These IDs record
  // known associations; live group membership/placement remains server-owned.
  const bound=source?{...source,groupIds:[...new Set([...(local.publicationSource?.setId===source.setId?local.publicationSource.groupIds:[]),...source.groupIds])].sort()}:undefined;
  const same=local.cloudSetId===result.id&&local.visibility===result.visibility&&(!bound||JSON.stringify(local.publicationSource)===JSON.stringify(bound));
  if(same)return data;
  return {...data,problemSets:data.problemSets.map(s=>s.id!==localSetId?s:{...s,cloudSetId:result.id,visibility:result.visibility,...(bound?{publicationSource:bound}:{}),updatedAt})};
}
export function groupStudySelection(data:AppData,set:ProblemSet,publishedId:string,versionId:string){
  const source=set.publicationSource;
  const original=source&&set.cloudSetId===publishedId&&source.setId===publishedId&&source.versionId===versionId;
  if(!original&&(set.sourceSetId!==publishedId||set.sourceVersionId!==versionId))return null;
  const rows=original?source.manifest:set.sourceManifest;
  if(!rows?.length||new Set(rows.map(row=>row.logicalId)).size!==rows.length)return null;
  const manifest=new Map(rows.map(row=>[row.logicalId,row.contentRevision]));
  const logicalByQuestionId=new Map<string,string>();
  const eligible=new Map(data.questions.filter(q=>{
    if(q.setId!==set.id)return false;
    const logical=original?q.logicalId??q.origin?.logicalId??q.id:q.origin?.logicalId;
    const valid=logical&&(original?manifest.get(logical)===publishedQuestionRevision(q):q.origin?.setId===publishedId&&q.origin.publicationVersionId===versionId&&manifest.get(logical)===q.origin.contentRevision&&questionRevision(q)===q.origin.importedContent);
    if(valid)logicalByQuestionId.set(q.id,logical!);return Boolean(valid);
  }).map(q=>[q.id,q]));
  return {manifest,eligible,logicalByQuestionId,kind:original?'source' as const:'copy' as const};
}
/** A live server group relation and its owner gate all original-source candidates. */
export function groupStudyCandidates(data:AppData,shared:CloudProblemSet,userId:string,currentVersionOnly=true):ProblemSet[]{
  return data.problemSets.flatMap(local=>{
    if(shared.ownerId===userId&&shared.localSetId===local.id&&local.cloudSetId===shared.id){
      const source=shared.questions?.length&&shared.versionId?publicationSourceFromSnapshot(shared,userId,local.id,local.publicationSource?.groupIds,true):local.publicationSource;
      if(source?.ownerId===userId&&source.setId===shared.id&&(!shared.versionId||source.versionId===shared.versionId))return [{...local,publicationSource:source}];
    }
    if(local.sourceSetId===shared.id&&local.sourceVersionId&&(!currentVersionOnly||local.sourceVersionId===shared.versionId)&&groupStudySelection(data,local,shared.id,local.sourceVersionId))return [local];
    return [];
  }).sort((a,b)=>Number(Boolean(b.publicationSource?.setId===shared.id))-Number(Boolean(a.publicationSource?.setId===shared.id))||(b.copiedAt??b.createdAt).localeCompare(a.copiedAt??a.createdAt)||a.id.localeCompare(b.id));
}
