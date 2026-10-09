import type {AppData,ProblemSetVisibility} from '../types';
import {localFolderPath,type SharedFolderPart} from './sharedFolders';
export interface LocalPublicationOptions {
  data:AppData;setId:string;visibility:Exclude<ProblemSetVisibility,'private'>;groupIds?:string[];addDestinations?:boolean;authorName:string;
  publicationInfo?:{audience:string;description:string};includeFolder?:boolean;folderPath?:SharedFolderPart[];keepVisibility?:boolean;
}
export interface PublicationPayload {p_set:Record<string,unknown>;p_questions:Record<string,unknown>[]}
export function prepareLocalPublication(params:LocalPublicationOptions):PublicationPayload {
  const set=params.data.problemSets.find(set=>set.id===params.setId);
  if(!set)throw new Error('共有する問題セットが見つかりません。');
  const audience=(params.publicationInfo?.audience??set.audience??'').trim(),description=(params.publicationInfo?.description??set.description??'').trim();
  if(!audience)throw new Error('対策・用途を選んでください。');if(description.length>300)throw new Error('説明は300文字以内で入力してください。');
  const questions=params.data.questions.filter(question=>question.setId===params.setId);if(!questions.length)throw new Error('問題がないセットは共有できません。');
  return {p_set:{local_set_id:set.id,...(params.folderPath!==undefined?{folder_path:params.folderPath}:params.includeFolder?{folder_path:localFolderPath(params.data.folders,set.folderId)}:{}),title:set.title,description,subject:set.subject??'',audience,difficulty:set.difficulty??'basic',creation_method:set.creationMethod??'manual',source:set.source??'',visibility:params.visibility,author_name:params.authorName.trim(),group_ids:params.groupIds??[],add_destinations:params.addDestinations??false,...(params.keepVisibility?{keep_visibility:true}:{})},
    p_questions:questions.map((question,position)=>({logical_id:question.logicalId??question.origin?.logicalId??question.id,position,question:question.question,choices:question.choices,distractors:question.distractors??[],shuffle_choices:question.shuffleChoices??null,answer_indexes:question.answerIndexes?.length?question.answerIndexes:[question.answerIndex],answer_text:question.answerText,explanation:question.explanation,detailed_explanation:question.detailedExplanation??'',source_page:question.sourcePage,category:question.category,difficulty:question.difficulty}))};
}
