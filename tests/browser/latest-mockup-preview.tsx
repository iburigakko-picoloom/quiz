import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProblemSetDetailScreen} from '../../src/screens/ProblemSetDetailScreen';
import {CommunityScreen} from '../../src/screens/CommunityScreen';
import {PrimaryBottomNav} from '../../src/components/PrimaryBottomNav';
import {createInitialProgress} from '../../src/utils/quiz';
import type {AppData} from '../../src/types';
import '../../src/index.css';import '../../src/ui-spec.css';import '../../src/final-reference.css';import '../../src/group-ui.css';
const timestamp='2026-10-11T00:00:00Z';
const seed:AppData={version:1,folders:[{id:'folder',name:'医学',createdAt:timestamp,updatedAt:timestamp}],problemSets:[{id:'set',folderId:'folder',title:'脳神経',createdAt:timestamp,updatedAt:timestamp}],questions:Array.from({length:267},(_,index)=>({id:`q${index}`,setId:'set',question:`確認問題 ${index+1}`,choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'',category:['解剖・生理','疾患MAP','脳血管障害'][index%3],difficulty:'basic',createdAt:timestamp,updatedAt:timestamp})),progress:Array.from({length:267},(_,index)=>({...createInitialProgress(`q${index}`),answeredCount:index<112?0:1,reviewLevel:index<112?null:index<187?1:2,isReview:index>=112&&index<222})),answerLogs:[]};
function Preview(){
 const [data,setData]=useState(seed),[groupPage,setGroupPage]=useState<'create'|'join'|undefined>(),[groupId,setGroupId]=useState<string|undefined>();
 const action=(name:string)=>{document.body.dataset.action=name;};
 return new URLSearchParams(location.search).get('view')==='groups'?<><CommunityScreen data={data} initialTab="groups" initialGroupId={groupId} groupPage={groupPage} onGroupPage={setGroupPage} onBack={()=>{setGroupPage(undefined);setGroupId(undefined);}} onManageShares={()=>{}} onCreateProblemSet={()=>{}} onOpenGroup={setGroupId} onOpenLocalSet={()=>{}} onCopySharedSet={async()=>null} onPracticeSharedSet={()=>{}} onPublished={async()=>{}} onUnpublished={async()=>{}}/><PrimaryBottomNav active="groups" onSelect={()=>{}}/></>:<ProblemSetDetailScreen data={data} setId="set" onBack={()=>{}} onEdit={()=>{}} onOpenProblemList={()=>action('questions')} onOpenNoteList={()=>action('notes')} onOpenMaterials={()=>action('materials')} onShare={()=>{}} onCreatePlan={()=>action('plan')} onToggleStudyCompleted={async id=>{setData({...data,problemSets:data.problemSets.map(set=>set.id===id?{...set,isStudyCompleted:!set.isStudyCompleted}:set)});return true;}} onStartSession={params=>{document.body.dataset.session=JSON.stringify({mode:params.mode,count:params.questions.length});}}/>;
}
createRoot(document.getElementById('root')!).render(import.meta.env.VITE_SUPABASE_URL==='https://latest-preview.example.test'?<Preview/>:<p>隔離した検証専用画面です。</p>);
