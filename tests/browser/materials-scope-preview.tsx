import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PDFDocument} from 'pdf-lib';
import {MaterialsDrawer,type MaterialsDrawerHandle} from '../../src/components/MaterialsDrawer';
import {saveCategoryNoteRaw,loadCategoryNoteRaw} from '../../src/utils/noteStorage';
import {materialIndexKey,materialFileKey,loadMaterials,annotationCategory} from '../../src/utils/materialStorage';
import {applyReferenceLinks,type ReferenceLink} from '../../src/utils/referenceLinking';
import {linkQuestionMaterialPage} from '../../src/utils/materialModel';
import {saveAppDataAsync} from '../../src/storage';
import type {AppData} from '../../src/types';
import '../../src/index.css';import '../../src/ui-spec.css';import '../../src/final-reference.css';
const stamp='2026-10-12T00:00:00Z';
const data:AppData={version:1,folders:[{id:'f',name:'教材',createdAt:stamp,updatedAt:stamp}],problemSets:['local','other','empty'].map(id=>({id,folderId:'f',title:id,createdAt:stamp,updatedAt:stamp})),questions:[
 {id:'q1',setId:'local',question:'未登録の問題',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'p.1',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp},
 {id:'q2',setId:'local',question:'既存の別セット参照',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'p.1',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,materialReferences:[{materialId:'linked',pageId:'linked-page'}]},
],progress:[],answerLogs:[]};
async function seed(){
 const doc=await PDFDocument.create();doc.addPage([200,280]);const bytes=await doc.save(),pdf='data:application/pdf;base64,'+btoa(String.fromCharCode(...bytes));
 await saveAppDataAsync(data);
 for(const [setId,materials] of [['local',[['attached','脳神経.pdf']]],['other',[['linked','循環器資料.pdf'],['unrelated','別セットの無関係なPDF.pdf']]]] as const){
  await saveCategoryNoteRaw(materialIndexKey(setId),JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:setId,updatedAt:stamp,materials:materials.map(([id,title])=>({id,title,pages:[{id:`${id}-page`,kind:'pdf',pdfPage:1}]}))}));
  for(const [id] of materials)await saveCategoryNoteRaw(materialFileKey(setId,id),JSON.stringify({kind:'quiz-material-file',version:1,materialId:id,updatedAt:stamp,dataUrl:pdf}));
 }
 const ink=JSON.stringify({dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',updatedAt:stamp});
 await saveCategoryNoteRaw(`quizMake:notes:other:${annotationCategory('linked','linked-page')}`,ink);
 return bytes;
}
function Preview(){
 const [current,setCurrent]=useState(data),[questionId,setQuestionId]=useState('q1'),[open,setOpen]=useState(true),drawer=useRef<MaterialsDrawerHandle>(null);
 const setId=new URLSearchParams(location.search).has('empty')?'empty':'local',question=current.questions.find(q=>q.id===questionId);
 const select=async(id:string)=>{await drawer.current?.flush();if(id===questionId)await drawer.current?.openReference(current.questions.find(q=>q.id===id)?.materialReferences?.[0]);else setQuestionId(id);};
 const link=async(links:ReferenceLink[])=>{const next=applyReferenceLinks(current,setId,links,stamp);if(!await saveAppDataAsync(next))throw Error('fixture save failed');setCurrent(next);};
 return <main style={{padding:20}}><h1>脳神経</h1><button onClick={()=>void select('q1')}>直接追加したPDFを開く</button><button onClick={()=>void select('q2')}>既存の参照先を開く</button>
  <MaterialsDrawer ref={drawer} problemSetId={setId} setIds={current.problemSets.map(s=>s.id)} questionId={questionId} references={setId==='local'?question?.materialReferences:undefined} questions={current.questions.filter(q=>q.setId===setId)} onLinkBatch={link} onLinkPage={async(reference,linked)=>{const next=linkQuestionMaterialPage(current,questionId,reference,linked,stamp);if(!await saveAppDataAsync(next))throw Error('fixture save failed');setCurrent(next);}} open={open} onOpenChange={setOpen}/>
 </main>;
}
if(import.meta.env.VITE_SUPABASE_URL==='https://materials-scope.example.test'){
 const bytes=await seed();Object.assign(window,{materialsFixture:{pdfBytes:[...bytes],read:async()=>({local:await loadMaterials('local'),other:await loadMaterials('other'),ink:await loadCategoryNoteRaw(`quizMake:notes:other:${annotationCategory('linked','linked-page')}`)})}});
 createRoot(document.getElementById('root')!).render(<Preview/>);
}else createRoot(document.getElementById('root')!).render(<p>隔離した資料検証画面です。</p>);
