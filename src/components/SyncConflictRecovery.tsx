import { useLayoutEffect, useMemo, useState } from 'react';
import { CompanionBudgetRecovery } from './CompanionBudgetRecovery';
import { RecordConflictPanel } from './RecordConflictPanel';
import { getRemoteSyncConfig } from '../utils/syncService';
import { requestSyncRetry } from '../utils/syncRequest';

/** Both account and legacy sync screens expose the existing protected resolvers. */
export function SyncConflictRecovery({syncId,accountId,onImported,onBusyChange,onOpenBackups,disabled=false}:{
 syncId:string;accountId:string;onImported?:()=>Promise<void>;onBusyChange?:(value:boolean)=>void;onOpenBackups?:()=>void;disabled?:boolean;
}) {
 const [careBusy,setCareBusy]=useState(false),[recordBusy,setRecordBusy]=useState(false),[open,setOpen]=useState(false);
 const url=getRemoteSyncConfig()?.url;
 const connection=useMemo(()=>url?{project:new URL(url).origin,userId:accountId,syncId}:undefined,[url,accountId,syncId]);
 useLayoutEffect(()=>{onBusyChange?.(careBusy||recordBusy||open);return()=>onBusyChange?.(false);},[careBusy,recordBusy,open,onBusyChange]);
 if(!connection)return null;
 return <>
  <CompanionBudgetRecovery connection={connection} disabled={disabled||open||recordBusy} onBusyChange={setCareBusy} onResolved={async()=>{
   await onImported?.();
   // Resume after React has released the protected-work flag, including when auto sync is off.
   window.setTimeout(()=>requestSyncRetry(syncId),0);
  }}/>
  {!careBusy&&!disabled&&<RecordConflictPanel syncId={syncId} accountId={accountId} open={open} onOpenChange={setOpen} onBusyChange={setRecordBusy} onImported={onImported} onOpenBackups={onOpenBackups}/>}
 </>;
}
