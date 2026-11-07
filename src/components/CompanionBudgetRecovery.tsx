import { useEffect, useState } from 'react';
import { readCompanionBudgetConflicts, resolveCompanionBudgetConflict, type CompanionBudgetConflict } from '../utils/companionBudgetRecovery';
import { parseCompanionCare, mergeCompanionBudgets } from '../utils/companionCare';
export function CompanionBudgetRecovery({onResolved}:{onResolved?:()=>Promise<void>}) {
 const [items,setItems]=useState<CompanionBudgetConflict[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const load=async()=>setItems(await readCompanionBudgetConflicts());
 useEffect(()=>{void load().catch(()=>{});},[]);
 const resolve=async(id:string,side:'local'|'remote')=>{if(busy)return;setBusy(true);setError('');try{await resolveCompanionBudgetConflict(id,side,items.find(item=>item.id===id));await load();setMessage('育成を統合しました。同期ではこの端末のデータを選択してください。');await onResolved?.();}catch(e){setError(e instanceof Error?e.message:'育成の変更を確定できません。');}finally{setBusy(false);}};
 return <>{message&&<p role="status">{message}</p>}{items.map(item=><section key={item.id} className="record-recovery"><h2>育成の変更を確認</h2><p>消費記録と回答IDは両方を保持します。移行済みの過去回答は再加算しません。名前・なかよし度・芸を選んでください。</p><div className="sync-actions">{(['local','remote'] as const).map(side=>{let care,merged;try{care=parseCompanionCare(item[side]);merged=mergeCompanionBudgets(care,parseCompanionCare(item[side==='local'?'remote':'local']));}catch{return <p key={side} role="alert">消費記録を照合できません。原本JSONを書き出して確認してください。</p>;}return <button key={side} disabled={busy} onClick={()=>void resolve(item.id,side)}>{side==='local'?'この端末':'別の端末'}の育成を使う（{care.name}・なかよし度{Number(care.friendship.toFixed(2))}・{merged.answerBalance < 0 ? `補充分${-merged.answerBalance}問` : `残り${merged.answerBalance}問分`}）</button>;})}</div></section>)}{error&&<p role="alert">{error}</p>}</>;
}
