import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {QuizRunner} from '../../src/screens/QuizRunner';
import type {AppData,Question} from '../../src/types';
import '../../src/index.css';import '../../src/ui-spec.css';import '../../src/final-reference.css';
const at='2026-11-09T00:00:00Z';
const choices=['腎臓の選択肢','尿管の選択肢','膀胱の選択肢','別の選択肢'];
const explanation='## 尿の生成と調節\n'+Array.from({length:10},(_,i)=>`**重要語${i+1}**を含む検証用の概念説明です。長文のスクロールと本文の保持を確認します。`).join('\n\n')+'\n\n### ポイント\n消してはいけない旧形式の説明。\n\n'+choices.map((c,i)=>`### 選択肢：${c}\n**判断条件${i+1}**を含む、この選択肢の検証用の理由です。`).join('\n\n');
const q:Question={id:'q1',setId:'s',question:'正しい選択肢を選んでください。',choices,answerIndex:0,answerIndexes:[0,2],answerText:choices[0]+' / '+choices[2],explanation,detailedExplanation:'保存済みの追加メモ',sourcePage:'',category:'',difficulty:'basic',createdAt:at,updatedAt:at,shuffleChoices:true};
const questions=[q,{...q,id:'q2',question:'次の問題です。',explanation:'昔からある**通常の解説**を残します。 [危険リンク](javascript:alert(1)) <script>window.unsafeExecuted=true</script>',shuffleChoices:false}];
function Preview(){const [data,setData]=useState<AppData>({version:1,folders:[{id:'f',name:'検証',createdAt:at}],problemSets:[{id:'s',folderId:'f',title:'検証',createdAt:at}],questions,progress:[],answerLogs:[]});return <QuizRunner data={data} title="泌尿器" questions={questions} mode="quiz" onBack={()=>{}} onFinish={()=>{}} onAnswer={()=>({isCorrect:true,addedToReview:false,levelLabel:'Level 1',savePromise:Promise.resolve(true)})} onToggleAmbiguous={async()=>true} onSaveDetailedExplanation={async(id,text)=>{setData(old=>({...old,questions:old.questions.map(q=>q.id===id?{...q,detailedExplanation:text}:q)}));}}/>;}
createRoot(document.getElementById('root')!).render(<Preview/>);
