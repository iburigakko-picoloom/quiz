import { accountLocalStorage, getAccountStorageSession, sameLocalAccount, type LocalAccountIdentity } from './accountStorage';

export const ACCOUNT_SYNC_CONNECTION_KEY='quizMake:sync:accountConnection:v1';
export const ACCOUNT_SYNC_EVENT='quiz-make-account-sync-change';
export const ACCOUNT_SYNC_RETRY_EVENT='quiz-make-account-sync-connect';
export type AccountSyncPhase='signed_out'|'connecting'|'ready'|'paused'|'offline'|'selection_required'|'migration_required'|'legacy_connection'|'not_found'|'deleted'|'unavailable'|'failed';
export type AccountSyncState={phase:AccountSyncPhase;syncId?:string;choices?:Array<{syncId:string;updatedAt:string}>};
type Marker={schema:1;identity:LocalAccountIdentity;syncId:string;paused:boolean};
let state:AccountSyncState={phase:'connecting'};
export const getAccountSyncState=()=>state;
export function publishAccountSyncState(next:AccountSyncState){state=next;if(typeof window!=='undefined')window.dispatchEvent(new Event(ACCOUNT_SYNC_EVENT));}
export function requestAccountSyncConnection(syncId?:string){window.dispatchEvent(new CustomEvent(ACCOUNT_SYNC_RETRY_EVENT,{detail:{syncId}}));}
export const strongAccountSyncId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{36}$/u.test(value);
export function readAccountSyncMarker():Marker|null{
  const session=getAccountStorageSession();if(!session?.identity)return null;
  const raw=accountLocalStorage.getItem(ACCOUNT_SYNC_CONNECTION_KEY);if(!raw)return null;
  const marker=JSON.parse(raw) as Marker;
  if(marker?.schema!==1||!sameLocalAccount(marker.identity,session.identity)||!strongAccountSyncId(marker.syncId)||typeof marker.paused!=='boolean')throw new Error('アカウントの保存先を確認できません。端末データは保持しています。');
  return marker;
}
export function isAccountSyncConnected(syncId:string):boolean{
  try{const marker=readAccountSyncMarker();return Boolean(marker&&marker.syncId===syncId&&marker.syncId===accountLocalStorage.getItem('quizMake:sync:id')&&state.phase==='ready'&&state.syncId===syncId)}catch{return false}
}
export function accountAutomaticSyncEnabled():boolean|null{
  const session=getAccountStorageSession();if(!session)return null;if(!session.identity)return false;
  try{const marker=readAccountSyncMarker();return Boolean(marker&&!marker.paused&&isAccountSyncConnected(marker.syncId))}catch{return false}
}
export function writeAccountSyncMarker(identity:LocalAccountIdentity,syncId:string,paused=false){
  const session=getAccountStorageSession();session?.assertCurrent(identity);
  if(!session?.identity||!strongAccountSyncId(syncId)||accountLocalStorage.getItem('quizMake:sync:id')!==syncId)throw new Error('アカウントの保存先を確認できません。端末データは保持しています。');
  const raw=JSON.stringify({schema:1,identity,syncId,paused} satisfies Marker);accountLocalStorage.setItem(ACCOUNT_SYNC_CONNECTION_KEY,raw);
  if(accountLocalStorage.getItem(ACCOUNT_SYNC_CONNECTION_KEY)!==raw)throw new Error('アカウントの保存先を端末に記録できません。端末データは保持しています。');
}
export function pauseAccountSync(paused:boolean){const marker=readAccountSyncMarker();if(marker){writeAccountSyncMarker(marker.identity,marker.syncId,paused);publishAccountSyncState({phase:paused?'paused':'ready',syncId:marker.syncId})}}

type ResolverResult={code:string;syncId?:string;created?:boolean;choices?:Array<{syncId:string;updatedAt:string}>};
export function parseAccountResolverResult(value:unknown):ResolverResult{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_response');
  const row=value as ResolverResult;
  if(!['ok','selection_required','migration_required','legacy_connection','not_found','deleted','retry'].includes(row.code))throw new Error('invalid_response');
  if(['ok','migration_required'].includes(row.code)&&!strongAccountSyncId(row.syncId))throw new Error('invalid_response');
  if(row.code==='ok'&&typeof row.created!=='boolean')throw new Error('invalid_response');
  if(row.code==='selection_required'){
    if(!Array.isArray(row.choices)||row.choices.length<2||row.choices.length>51||new Set(row.choices.map(c=>c?.syncId)).size!==row.choices.length||row.choices.some(c=>!c||typeof c.syncId!=='string'||!c.syncId||c.syncId.length>256||typeof c.updatedAt!=='string'||!Number.isFinite(Date.parse(c.updatedAt))))throw new Error('invalid_response');
  }
  return row;
}
export type AccountSyncDependencies={identity:LocalAccountIdentity;assertCurrent:()=>void|Promise<void>;readSyncId:()=>string;readBinding:()=>Promise<(LocalAccountIdentity&{syncId:string})|null>;resolve:(candidate:string|null)=>Promise<unknown>;install:(syncId:string)=>Promise<void>};
/** A resolver response never authorizes changing another stream's revision
 * history. Resolve ownership first; exact binding checks precede installation. */
export async function resolveAccountSync(deps:AccountSyncDependencies,selection?:string):Promise<AccountSyncState>{
  await deps.assertCurrent();const existing=deps.readSyncId().trim(),binding=await deps.readBinding();await deps.assertCurrent();
  if(binding&&!sameLocalAccount(binding,deps.identity))throw new Error('connection_changed');
  if(binding&&existing&&binding.syncId!==existing)return {phase:'migration_required'};
  if(existing&&!strongAccountSyncId(existing))return {phase:'legacy_connection'};
  if(selection!==undefined&&!strongAccountSyncId(selection))return {phase:'legacy_connection'};
  const selected=selection??(existing||binding?.syncId||null);
  const result=parseAccountResolverResult(await deps.resolve(selected));await deps.assertCurrent();
  if(deps.readSyncId().trim()!==existing)throw new Error('connection_changed');
  if(result.code==='ok'){
    const id=result.syncId!;
    if(binding&&binding.syncId!==id||existing&&existing!==id)return {phase:'migration_required',syncId:id};
    await deps.install(id);await deps.assertCurrent();return {phase:'ready',syncId:id};
  }
  if(result.code==='retry')return {phase:'failed'};
  return {phase:result.code as AccountSyncPhase,...(result.syncId?{syncId:result.syncId}:{}),...(result.choices?{choices:result.choices}:{})};
}
