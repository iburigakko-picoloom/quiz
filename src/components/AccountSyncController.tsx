import {useEffect} from 'react';
import {getAccountStorageSession,assertAccountNetworkCurrent,accountLocalStorage} from '../utils/accountStorage';
import {getCachedCloudAccountIdentity,getCloudAccessToken} from '../utils/cloudService';
import {cloudAccessFailureCode} from '../utils/cloudAuthAccess';
import {readStoredAccountBinding} from '../utils/accountStorageBootstrap';
import {ACCOUNT_SYNC_RETRY_EVENT,getAccountSyncState,publishAccountSyncState,readAccountSyncMarker,resolveAccountSync,writeAccountSyncMarker} from '../utils/accountSync';
import {getRemoteSyncConfig,getStoredSyncId,setStoredSyncId} from '../utils/syncService';
import {setRecordSyncOptIn} from '../utils/recordSyncOptIn';
import {bindRecordSyncConnection} from '../utils/recordSyncOutbox';
import {openAppDb} from '../storage';
import {openCoLocatedNoteDb} from '../utils/noteRecordMigration';
import {withCoordinatedDataRead} from '../utils/dataCoordination';

export function AccountSyncController(){
  useEffect(()=>{
    const owner=getAccountStorageSession(),identity=owner?.identity,config=getRemoteSyncConfig();
    if(!identity){publishAccountSyncState({phase:'signed_out'});return}
    if(!config){publishAccountSyncState({phase:'unavailable'});return}
    let disposed=false,running=false,retryTimer:number|undefined;
    const assertCurrent=()=>{if(disposed)throw new Error('connection_changed');assertAccountNetworkCurrent(getCachedCloudAccountIdentity());owner.assertCurrent(identity)};
    const run=async(selection?:string)=>{
      if(disposed||running)return;
      try{const marker=readAccountSyncMarker();if(!selection&&marker?.paused&&marker.syncId===getStoredSyncId()){publishAccountSyncState({phase:'paused',syncId:getStoredSyncId()});return}}catch{publishAccountSyncState({phase:'failed'});return}
      if(selection===undefined&&getAccountSyncState().phase==='ready'&&getAccountSyncState().syncId===getStoredSyncId())return;
      if(navigator.onLine===false){publishAccountSyncState({phase:'offline'});return}
      running=true;window.clearTimeout(retryTimer);publishAccountSyncState({phase:'connecting'});
      try{
        const next=await resolveAccountSync({identity,assertCurrent,readSyncId:getStoredSyncId,
          readBinding:()=>readStoredAccountBinding(indexedDB,owner.databaseName('quiz-make-app-data-v1')),
          resolve:async(candidate)=>{
             const access=await getCloudAccessToken();assertCurrent();if(!access.ok)throw new Error(cloudAccessFailureCode(access.reason));if(access.userId!==identity.userId)throw new Error('connection_changed');
            const controller=new AbortController(),timeout=window.setTimeout(()=>controller.abort(),15000);
            try{
              const response=await fetch(config.url+'/rest/v1/rpc/quiz_sync_resolve_account',{method:'POST',headers:{apikey:config.anonKey,Authorization:'Bearer '+access.accessToken,'Content-Type':'application/json'},body:JSON.stringify({p_existing_sync_id:candidate}),signal:controller.signal});assertCurrent();
               if(!response.ok)throw new Error(response.status===404?'unavailable':response.status===401?'authentication_required':response.status===403?'permission_denied':'network');
              return response.json();
            }finally{window.clearTimeout(timeout)}
          },install:async(syncId)=>withCoordinatedDataRead(['app','notes'],async()=>{
            assertCurrent();const binding=await readStoredAccountBinding(indexedDB,owner.databaseName('quiz-make-app-data-v1'));assertCurrent();
            if(binding&&(binding.syncId!==syncId||binding.userId!==identity.userId||binding.project!==identity.project))throw new Error('connection_changed');
            // Establish a valid local record ancestor before observing a remote
            // timestamp. Otherwise a genuinely new device looks like lost data.
            // The strict migration refuses unreadable/tainted existing stores.
            await openCoLocatedNoteDb();assertCurrent();
            await bindRecordSyncConnection(await openAppDb(),{...identity,syncId});assertCurrent();
            if(getStoredSyncId()!==syncId){const result=setStoredSyncId(syncId);if(!result.ok)throw new Error('local_persistence_failed')}
            const opted=setRecordSyncOptIn(syncId,true);if(!opted.ok)throw new Error('local_persistence_failed');
            writeAccountSyncMarker(identity,syncId);
          },{requireCrossContext:true})},selection);
        assertCurrent();if(next.choices)accountLocalStorage.setItem('quizMake:sync:ownedCandidates:v1',JSON.stringify({identity,choices:next.choices}));publishAccountSyncState(next);
        if(next.phase==='ready')window.dispatchEvent(new Event('quiz-make-sync-settings-change'));
        if(next.phase==='failed')retryTimer=window.setTimeout(()=>void run(),30000);
      }catch(error){
        if(disposed)return;
        const code=error instanceof Error?error.message:'';
        publishAccountSyncState({phase:code==='unavailable'?'unavailable':!navigator.onLine?'offline':'failed'});
         if(code==='network'||error instanceof TypeError||error instanceof DOMException&&error.name==='AbortError')retryTimer=window.setTimeout(()=>void run(),30000);
      }finally{running=false}
    };
    const retry=(event:Event)=>void run((event as CustomEvent<{syncId?:string}>).detail?.syncId);
    const online=()=>void run();
    window.addEventListener(ACCOUNT_SYNC_RETRY_EVENT,retry);window.addEventListener('online',online);window.addEventListener('focus',online);
    const timer=window.setTimeout(()=>void run(),0);
    return()=>{disposed=true;window.clearTimeout(timer);window.clearTimeout(retryTimer);window.removeEventListener(ACCOUNT_SYNC_RETRY_EVENT,retry);window.removeEventListener('online',online);window.removeEventListener('focus',online)};
  },[]);
  return null;
}
