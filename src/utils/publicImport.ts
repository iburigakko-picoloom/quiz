import type {AppData,Folder,ProblemSet,Question} from '../types';
import type {PublicFolder,PublicSet} from './publicLibrary';
import {createId} from './id';
import {questionRevision} from './studyPlans';

/** Prepare all copies before one durable app commit. No source object is mutated. */
export function planPublicImport(data:AppData,sets:PublicSet[],options:{folder?:PublicFolder;targetId?:string;newFolderName?:string},timestamp=new Date().toISOString()){
  if(!sets.length)throw new Error('取り込める問題セットがありません。');
  for(const set of sets){const questions=set.questions;if(!questions?.length||questions.length!==set.questionCount||questions.some(q=>q.choices.length<4||q.choices.length>5||q.choices.some(c=>typeof c!=='string')||!q.answerIndexes.length||q.answerIndexes.some(i=>!Number.isInteger(i)||i<0||i>=q.choices.length)))throw new Error('公開された問題の内容を確認できません。端末データは変更していません。');}
  const folders=[...data.folders],problemSets=[...data.problemSets],questions=[...data.questions],progress=[...data.progress],imported:{cloudId:string;localId:string}[]=[];
  const addFolder=(name:string,parentFolderId?:string,source?:Partial<Folder>)=>{const base=name.trim()||'取り込んだ教材';let candidate=base,n=2;while(folders.some(f=>f.parentFolderId===parentFolderId&&f.name===candidate))candidate=`${base} (${n++})`;const folder:Folder={id:createId('folder'),name:candidate,parentFolderId,createdAt:timestamp,updatedAt:timestamp,...source};folders.push(folder);return folder;};
  let root:Folder|undefined;
  if(options.folder)root=folders.find(f=>!f.parentFolderId&&f.sourcePublicFolderId===options.folder!.id&&f.sourcePublicFolderOwnerId===options.folder!.ownerId)??addFolder(options.newFolderName||options.folder.name,undefined,{sourcePublicFolderId:options.folder.id,sourcePublicFolderOwnerId:options.folder.ownerId});
  else root=options.targetId?folders.find(f=>f.id===options.targetId):addFolder(options.newFolderName||'取り込んだ教材');
  if(!root)throw new Error('取り込み先のフォルダがありません。選び直してください。');
  for(const set of sets){
    let destination=root;
    const child=set.memberPath?.[0];if(options.folder&&child)destination=folders.find(f=>f.parentFolderId===root!.id&&f.sourcePublicChildId===child.id)??addFolder(child.name,root.id,{sourcePublicChildId:child.id,sourcePublicFolderId:options.folder.id,sourcePublicFolderOwnerId:options.folder.ownerId});
    const existing=set.versionId?problemSets.find(s=>s.folderId===destination.id&&s.sourceSetId===set.id&&s.sourceVersionId===set.versionId):undefined;
    const old=existing?questions.filter(q=>q.setId===existing.id):[];
    if(existing&&old.length===set.questions!.length&&old.every(q=>q.origin&&questionRevision(q)===q.origin.importedContent)){imported.push({cloudId:set.id,localId:existing.id});continue;}
    const setId=createId('set');let title=set.title,n=2;while(problemSets.some(s=>s.folderId===destination.id&&s.title===title))title=`${set.title} (${n++})`;
    const local:ProblemSet={id:setId,folderId:destination.id,title,source:set.source,description:set.description,subject:set.subject,audience:set.audience,difficulty:set.difficulty,creationMethod:'public-copy',visibility:'private',sourceSetId:set.id,sourceVersionId:set.versionId,sourceOwnerId:set.ownerId,sourceOwnerName:set.authorName,copiedAt:timestamp,createdAt:timestamp,updatedAt:timestamp,sourceManifest:set.versionId&&set.questions!.every(q=>q.logicalId&&q.contentRevision)?set.questions!.map(q=>({logicalId:q.logicalId!,contentRevision:q.contentRevision!})):undefined};
    problemSets.push(local);
    for(const q of set.questions!){const answers=[...new Set(q.answerIndexes)];const copy:Question={id:createId('q'),logicalId:q.logicalId,setId,question:q.question,choices:[...q.choices] as Question['choices'],distractors:q.distractors?[...q.distractors]:undefined,shuffleChoices:q.shuffleChoices,answerIndex:answers[0],answerIndexes:answers,answerText:q.answerText||answers.map(i=>q.choices[i]).join(' / '),explanation:q.explanation,detailedExplanation:q.detailedExplanation,sourcePage:q.sourcePage,category:q.category||'未分類',difficulty:q.difficulty,createdAt:timestamp,updatedAt:timestamp};
      if(set.versionId&&q.logicalId&&q.contentRevision)copy.origin={setId:set.id,logicalId:q.logicalId,publicationVersionId:set.versionId,contentRevision:q.contentRevision,importedContent:questionRevision(copy)};
      questions.push(copy);progress.push({questionId:copy.id,answeredCount:0,correctCount:0,wrongCount:0,lastSelectedIndex:null,lastAnswerCorrect:null,lastAnsweredAt:null,isReview:false,isAmbiguous:false,reviewLevel:null,isGraduated:false});
    }
    imported.push({cloudId:set.id,localId:setId});
  }
  return {data:{...data,folders,problemSets,questions,progress},imported,folderId:root.id};
}
