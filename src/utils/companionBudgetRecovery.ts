import { openAppDb } from '../storage';
import { withCoordinatedDataMutation } from './dataCoordination';
import { replayLocalStorageProjections, saveSyncedLocalStorage } from './localStorageRecords';
import { getAccountStorageSession } from './accountStorage';
import { COMPANION_CARE_KEY, COMPANION_CARE_EVENT, mergeCompanionBudgets, parseCompanionCare } from './companionCare';
import { appRecordKey } from './appRecordStorage';
import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
export interface CompanionBudgetConflict { id: string; local: string; remote: string; current: string | null; owner: ReturnType<typeof getAccountStorageSession>; connection?: RecordSyncConnection }
export async function readCompanionBudgetConflicts(connection?: RecordSyncConnection): Promise<CompanionBudgetConflict[]> {
 const owner=getAccountStorageSession();
 const db=await openAppDb(),tx=db.transaction(['appRecordConflicts','appRecords','appRecordMeta']),store=tx.objectStore('appRecordConflicts');
 const current=tx.objectStore('appRecords').get(appRecordKey('localStorage',COMPANION_CARE_KEY));
 const binding=tx.objectStore('appRecordMeta').get('recordSyncConnection');
 const index=store.indexNames.contains('kind')?store.index('kind'):null;
 const values=index?index.getAll('companion-budget-conflict'):store.getAll(),keys=index?index.getAllKeys('companion-budget-conflict'):store.getAllKeys();await new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error);});
 const scope=connection??binding.result;
 if(owner!==getAccountStorageSession())throw new Error('アカウントが変わりました。原本を確認し直してください。');
 return values.result.flatMap((row,i)=>row.kind==='companion-budget-conflict'&&!row.resolvedAt&&row.local?.raw&&row.remote?.raw&&(!scope||row.connection&&sameRecordSyncConnection(row.connection,scope))?[{id:String(keys.result[i]),local:row.local.raw,remote:row.remote.raw,current:current.result?.raw??null,owner,connection:row.connection}]:[]);
}
/** Both the choice card and the commit use these exact same inputs. */
export function previewCompanionBudgetChoice(item: CompanionBudgetConflict, side: 'local' | 'remote') {
 const local=parseCompanionCare(item.current??item.local),remote=parseCompanionCare(item.remote);
 let merged=mergeCompanionBudgets(side==='local'?local:remote,side==='local'?remote:local);
 // Preserve spends from the archived original even if absent from the current view.
 merged=mergeCompanionBudgets(merged,parseCompanionCare(item.local));
 return merged;
}
export async function resolveCompanionBudgetConflict(id:string,side:'local'|'remote',expected?:CompanionBudgetConflict):Promise<void>{
 const owner=getAccountStorageSession(),native=globalThis.localStorage;
 const assertOwner=()=>{if((expected&&expected.owner!==owner)||owner!==getAccountStorageSession()||native!==globalThis.localStorage)throw new Error('アカウントが変わりました。育成の変更を確認し直してください。');owner?.assertCurrent();};
 await withCoordinatedDataMutation(['app'],async()=>{
  assertOwner();
  const db=await openAppDb();await replayLocalStorageProjections(db,[COMPANION_CARE_KEY]);
  const conflict=(await readCompanionBudgetConflicts(expected?.connection)).find(row=>row.id===id);if(!conflict||(expected&&(expected.local!==conflict.local||expected.remote!==conflict.remote||expected.current!==conflict.current)))throw new Error('競合の状態が変わりました。もう一度確認してください。');
  if(expected?.connection){
   const {readMeta}=await import('./blobVault');
   const binding=await readMeta<RecordSyncConnection>(db,'recordSyncConnection');
   if(!binding||!sameRecordSyncConnection(binding,expected.connection))throw new Error('同期先が変わりました。育成の変更を確認し直してください。');
  }
  assertOwner();
  const merged=previewCompanionBudgetChoice(conflict,side);
  assertOwner();
  await saveSyncedLocalStorage({[COMPANION_CARE_KEY]:JSON.stringify(merged)}, undefined, {
   stores:['appRecordConflicts'],
   write(tx){
    const store=tx.objectStore('appRecordConflicts'),request=store.get(id);
    request.onsuccess=()=>{
     const row=request.result;
     if(!row||row.resolvedAt||row.local?.raw!==conflict.local||row.remote?.raw!==conflict.remote){tx.abort();return;}
     store.put({...row,resolvedAt:new Date().toISOString(),choice:side},id);
    };
   },
  });
  assertOwner();
  window.dispatchEvent(new Event(COMPANION_CARE_EVENT));
 },{requireCrossContext:true});
}
