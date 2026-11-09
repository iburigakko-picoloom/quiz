import './SyncDataChoice.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readCompanionBudgetConflicts, resolveCompanionBudgetConflict, type CompanionBudgetConflict } from '../utils/companionBudgetRecovery';
import { parseCompanionCare, mergeCompanionBudgets, COMPANION_CARE_EVENT } from '../utils/companionCare';
import { SYNC_ATTEMPT_EVENT } from '../utils/syncAttemptStatus';
import type { RecordSyncConnection } from '../utils/recordSyncOutbox';

export function CompanionBudgetRecovery({onResolved, connection, onBusyChange, disabled = false}: {
 onResolved?:()=>Promise<void>; connection?:RecordSyncConnection; onBusyChange?:(busy:boolean)=>void; disabled?:boolean;
}) {
 const [items,setItems]=useState<CompanionBudgetConflict[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [choices,setChoices]=useState<Record<string,'local'|'remote'>>({});
 const lock=useRef(false);
 const shown=useRef<CompanionBudgetConflict[]>([]);
 useLayoutEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
 useEffect(()=>{
  let stopped=false,reading=false;
  shown.current=[];setItems([]);setChoices({});setError('');setMessage('');
  const load=async()=>{
   if(reading||lock.current)return;reading=true;
   try {const next=await readCompanionBudgetConflicts(connection);if(!stopped){
    const previous=shown.current;
    setChoices(current=>Object.fromEntries(Object.entries(current).filter(([id])=>{
     const old=previous.find(item=>item.id===id),fresh=next.find(item=>item.id===id);
     return old&&fresh&&old.local===fresh.local&&old.remote===fresh.remote;
    })));
    shown.current=next;setItems(next);
   }}catch{if(!stopped)setError('育成の変更を読み込めません。再度同期画面を開いてください。');}finally{reading=false;}
  };
  void load();const timer=window.setInterval(()=>void load(),5000);
  window.addEventListener(SYNC_ATTEMPT_EVENT,load);window.addEventListener(COMPANION_CARE_EVENT,load);
  return()=>{stopped=true;window.clearInterval(timer);window.removeEventListener(SYNC_ATTEMPT_EVENT,load);window.removeEventListener(COMPANION_CARE_EVENT,load);};
 },[connection?.project,connection?.userId,connection?.syncId]);
 const resolve=async(item:CompanionBudgetConflict)=>{
  const side=choices[item.id];if(lock.current||disabled||!side)return;
  lock.current=true;setBusy(true);setError('');
  try{
   await resolveCompanionBudgetConflict(item.id,side,item);
   setItems(await readCompanionBudgetConflicts(connection));
   setMessage('選んだ育成を保存しました。消費済みの回答数も保持しています。');
   await onResolved?.();
  }catch(e){setError(e instanceof Error?e.message:'育成の変更を確定できません。');}
  finally{lock.current=false;setBusy(false);}
 };
 return <>{message&&<p role="status">{message}</p>}{items.map(item=><section key={item.id} className="record-recovery">
  <h2>育成はどちらのデータを使いますか？</h2>
  <p>消費済みの回答数は両端末分を保持します。</p>
  <fieldset disabled={busy||disabled} className="sync-data-choices"><legend className="sync-choice-hidden">育成のデータ</legend>
   {(['local','remote'] as const).map(side=>{
    let care,merged;try{care=parseCompanionCare(item[side]);merged=mergeCompanionBudgets(care,parseCompanionCare(item[side==='local'?'remote':'local']));}
    catch{return <p key={side} role="alert">消費記録を照合できません。原本は保持しています。</p>;}
    return <label key={side} className={`sync-data-choice${choices[item.id]===side?' sync-data-choice--selected':''}`}><input type="radio" name={`care-${item.id}`} checked={choices[item.id]===side} onChange={()=>setChoices(value=>({...value,[item.id]:side}))}/><span className="sync-data-choice__content"><strong>{side==='local'?'この端末':'クラウド（ほかの端末）'}</strong><p>{care.name}・なかよし度 {Number(care.friendship.toFixed(2))}</p><p>{merged.answerBalance<0?`補充分 ${-merged.answerBalance}問`:`残り ${merged.answerBalance}問分`}</p></span></label>;
   })}
  </fieldset>
  <button type="button" className="sync-button sync-button--primary" disabled={busy||disabled||!choices[item.id]} onClick={()=>void resolve(item)}>{busy?'選択を保存中…':'この育成で同期を再開'}</button>
 </section>)}{error&&<p role="alert">{error}</p>}</>;
}
