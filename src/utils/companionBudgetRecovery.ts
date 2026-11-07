import { openAppDb } from '../storage';
import { withCoordinatedDataMutation } from './dataCoordination';
import { replayLocalStorageProjections, saveSyncedLocalStorage } from './localStorageRecords';
import { accountLocalStorage, getAccountStorageSession } from './accountStorage';
import { COMPANION_CARE_KEY, COMPANION_CARE_EVENT, mergeCompanionBudgets, parseCompanionCare } from './companionCare';
export interface CompanionBudgetConflict { id: string; local: string; remote: string; owner: ReturnType<typeof getAccountStorageSession> }
export async function readCompanionBudgetConflicts(): Promise<CompanionBudgetConflict[]> {
 const owner=getAccountStorageSession();
 const db=await openAppDb(),tx=db.transaction('appRecordConflicts'),store=tx.objectStore('appRecordConflicts');
 const values=store.getAll(),keys=store.getAllKeys();await new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error);});
 if(owner!==getAccountStorageSession())throw new Error('アカウントが変わりました。原本を確認し直してください。');
 return values.result.flatMap((row,i)=>row.kind==='companion-budget-conflict'&&!row.resolvedAt&&row.local?.raw&&row.remote?.raw?[{id:String(keys.result[i]),local:row.local.raw,remote:row.remote.raw,owner}]:[]);
}
export async function resolveCompanionBudgetConflict(id:string,side:'local'|'remote',expected?:CompanionBudgetConflict):Promise<void>{
 const owner=getAccountStorageSession(),native=globalThis.localStorage;
 const assertOwner=()=>{if((expected&&expected.owner!==owner)||owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('アカウントが変わりました。育成の変更を確認し直してください。');owner?.assertCurrent();};
 await withCoordinatedDataMutation(['app'],async()=>{
  assertOwner();
  const db=await openAppDb();await replayLocalStorageProjections(db,[COMPANION_CARE_KEY]);
  const conflict=(await readCompanionBudgetConflicts()).find(row=>row.id===id);if(!conflict||(expected&&(expected.local!==conflict.local||expected.remote!==conflict.remote)))throw new Error('競合の状態が変わりました。もう一度確認してください。');
  assertOwner();
  const local=parseCompanionCare(conflict.local),remote=parseCompanionCare(conflict.remote);
  let merged=mergeCompanionBudgets(side==='local'?local:remote,side==='local'?remote:local);
  const current=accountLocalStorage.getItem(COMPANION_CARE_KEY);if(current)merged=mergeCompanionBudgets(merged,parseCompanionCare(current));
  assertOwner();
  await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify(merged)});
  assertOwner();
  const tx=db.transaction('appRecordConflicts','readwrite'),store=tx.objectStore('appRecordConflicts'),request=store.get(id);
  request.onsuccess=()=>{if(request.result)store.put({...request.result,resolvedAt:new Date().toISOString(),choice:side},id);};
  await new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error);});
  window.dispatchEvent(new Event(COMPANION_CARE_EVENT));
 },{requireCrossContext:true});
}
