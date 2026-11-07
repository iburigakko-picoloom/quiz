import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QuizRunner} from '../../src/screens/QuizRunner';
import type {AppData, Question} from '../../src/types';
import '../../src/index.css';
const question={id:'q',setId:'s',question:'保存待機テスト',choices:['正解','不正解'],answerIndex:0,explanation:'解説',createdAt:'2026-11-07',updatedAt:'2026-11-07'} as Question;
const data={version:1,folders:[],problemSets:[{id:'s',title:'検証',createdAt:'2026-11-07',updatedAt:'2026-11-07'}],questions:[question],progress:[],answerLogs:[]} as AppData;
const state={calls:[] as unknown[],durable:false,resolve: (_saved:boolean)=>{},reject:()=>{}};
Object.assign(window,{activitySaveTest:state});
function Preview(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(false)}>強制終了</button>{open&&<QuizRunner data={data} title="検証" questions={[question]} mode="quiz" setId="s" onBack={()=>setOpen(false)} onFinish={()=>setOpen(false)} onToggleAmbiguous={async()=>true} onSaveDetailedExplanation={async()=>{}} onAnswer={()=>{
 const save=()=>new Promise<boolean>((resolve,reject)=>{state.resolve=saved=>{state.durable=saved;resolve(saved)};state.reject=()=>reject(new Error('save failed'))});
 return {isCorrect:true,addedToReview:false,answerLogId:'stable-log',savePromise:save(),retrySave:save};
}} onStudySessionEnd={(answers,identity)=>{state.calls.push({answers,identity,durable:state.durable})}}/>}</>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview/></React.StrictMode>);
