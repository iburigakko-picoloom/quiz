import React from 'react';
import {createRoot} from 'react-dom/client';
import {CreateProblemSetScreen} from '../../src/screens/CreateProblemSetScreen';
import type {AppData} from '../../src/types';
import { AccountStorageSession } from '../../src/utils/accountStorage';
import { captureAccountWork, restoreAccountWork } from '../../src/utils/accountWork';
import '../../src/index.css';
import '../../src/ui-spec.css';
import '../../src/final-reference.css';
const at='2026-11-07T00:00:00Z';
const data:AppData={version:1,folders:[{id:'folder',name:'授業',createdAt:at,updatedAt:at}],problemSets:[{id:'set',folderId:'folder',title:'元の問題セット',source:'原典',createdAt:at,updatedAt:at}],questions:[{id:'q',setId:'set',question:'元の問題',choices:['A','B','C','D'],answerIndex:0,answerIndexes:[0,1],answerText:'A/B',explanation:'根拠',sourcePage:'p.2',category:'基礎',difficulty:'basic',createdAt:at,updatedAt:at}],progress:[],answerLogs:[]};
const element=()=> (<CreateProblemSetScreen data={data} initialFolderId="folder" copySetId={new URLSearchParams(location.search).get('copy')??undefined} onApplyExplanations={async()=>{}} onSaveDetail={async()=>{}} onSave={async value=>{document.body.dataset.saved=JSON.stringify(value);return null;}} onOpenLegacyImport={value=>{document.body.dataset.legacy=JSON.stringify(value);}} onPrepareBatchImport={target=>target} onBatchImport={async(target,title,text)=>{const attempts=JSON.parse(document.body.dataset.batchAttempts??'[]');attempts.push({target,title,text});document.body.dataset.batchAttempts=JSON.stringify(attempts);if(document.body.dataset.pauseBatch==='yes'){delete document.body.dataset.pauseBatch;document.body.dataset.batchWaiting='yes';await new Promise<void>(resolve=>Object.assign(window,{releaseBatch:resolve}));delete document.body.dataset.batchWaiting;}if(title==='失敗教材'&&attempts.filter((item:{title:string})=>item.title===title).length===1)return '一時的な保存エラー';return null;}}/>);
if(import.meta.env.VITE_CREATION_PREVIEW==='true'){
 let root=createRoot(document.getElementById('root')!);root.render(element());
 Object.assign(window,{restoreCreationTestWork(){const session=new AccountStorageSession(localStorage,{identity:null,namespace:'guest',legacyUnclaimed:false});const saved=captureAccountWork(session);root.unmount();restoreAccountWork(saved,session);root=createRoot(document.getElementById('root')!);root.render(element());}});
}
