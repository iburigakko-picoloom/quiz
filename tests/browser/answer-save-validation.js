import { AccountStorageSession, accountGenerationKey, accountNamespace, activateAccountStorage } from '../../src/utils/accountStorage.ts';
import { saveAppDataResult, loadAppDataAsync, openAppDb } from '../../src/storage.ts';
import { recordAnswer } from '../../src/utils/quiz.ts';
import { readPreviousAppRecords, readCurrentAppRecordSnapshot } from '../../src/utils/appRecordStorage.ts';
import { shouldPruneQuestionImages } from '../../src/utils/localQuestionImages.ts';
const output=document.querySelector('#result'),button=document.querySelector('#start');
button.onclick=async()=>{
  button.disabled=true;
  try{
    const identity={project:'https://answer-save.invalid',userId:crypto.randomUUID()},generation='union-'+crypto.randomUUID();
    const values=new Map([[accountGenerationKey(identity),generation]]);
    const memory={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
    activateAccountStorage(new AccountStorageSession(memory,{identity,namespace:accountNamespace(identity),legacyUnclaimed:false}));
    const stamp=new Date().toISOString(),count=10000;
    const seed={version:1,folders:[{id:'f',name:'Synthetic',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'Synthetic',source:'',createdAt:stamp,updatedAt:stamp}],
      questions:Array.from({length:count},(_,index)=>({id:'q'+index,setId:'s',question:'Synthetic question '+index,choices:['A','B','C','D'],answerIndex:0,explanation:'Synthetic explanation. '.repeat(30),createdAt:stamp,updatedAt:stamp})),progress:[],answerLogs:[]};
    output.textContent='合成1万問を準備中';
    if(!(await saveAppDataResult(seed)).ok)throw Error('初期保存に失敗しました');
    let data=await loadAppDataAsync();const db=await openAppDb(),samples={general:[],answer:[]};
    let fullReads=0,unrelatedValidations=0;
    const originalGetAll=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll=function(...args){if(this.name==='appRecords')fullReads++;return originalGetAll.apply(this,args)};
    try{
      for(const mode of ['general','answer'])for(let index=0;index<5;index++){
        const previous=data,answerLogId=mode+'-'+index,result=recordAnswer(previous,previous.questions[0],[0],false,answerLogId);
        let choices;
        if(mode==='answer'){
          choices=previous.questions[count-1].choices;
          Object.defineProperty(previous.questions[count-1],'choices',{configurable:true,enumerable:true,get(){unrelatedValidations++;return choices}});
        }
        const start=performance.now();
        try{
          const saved=await saveAppDataResult(result.data,mode==='answer'?{answerChange:{previous,questionId:'q0',answerLogId}}:{});
          if(!saved.ok)throw Error('回答保存に失敗しました');
          samples[mode].push(performance.now()-start);
          if(mode==='answer'&&shouldPruneQuestionImages(previous.questions,result.data.questions))throw Error('回答に画像走査が必要と判定されました');
          await readCurrentAppRecordSnapshot(db);
        }finally{
          if(mode==='answer')Object.defineProperty(previous.questions[count-1],'choices',{value:choices,configurable:true,enumerable:true,writable:true});
        }
        data=result.data;
      }
    }finally{IDBObjectStore.prototype.getAll=originalGetAll}
    if(fullReads||unrelatedValidations)throw Error('不要な全件処理が発生しました');
    const persisted=await loadAppDataAsync(),undo=await readPreviousAppRecords(db);
    if(persisted.questions.length!==count||persisted.answerLogs.length!==10||persisted.progress[0].answeredCount!==10||undo.data.answerLogs.length!==9)throw Error('回答または直前の保存を復元できません');
    const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
    output.textContent=JSON.stringify({ok:true,questions:count,answers:10,fullRecordReads:fullReads,unrelatedQuestionValidations:unrelatedValidations,
      generalSaveMedianMs:Math.round(median(samples.general)*10)/10,answerSaveMedianMs:Math.round(median(samples.answer)*10)/10,samples},null,2);
    db.close();
  }catch(error){output.textContent=JSON.stringify({ok:false,message:error.message})}
};
