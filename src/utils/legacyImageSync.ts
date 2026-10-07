import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import type { MissingSyncImage } from './backupPayload';
import { SyncProtocolError } from './syncInterruption';

const KEY='wholeLegacyImages';
export type LegacyImageSync={version:1;connection:RecordSyncConnection;images:MissingSyncImage[]};
function validImages(value:unknown):value is MissingSyncImage[]{
  return Array.isArray(value)&&value.length<=200000&&value.every(row=>row&&typeof row.id==='string'&&!!row.id&&row.id.length<=512&&typeof row.questionId==='string'&&!!row.questionId&&row.questionId.length<=512)&&new Set(value.map(row=>row.id)).size===value.length;
}
export async function readLegacyImageSync(db:IDBDatabase,connection:RecordSyncConnection):Promise<LegacyImageSync|undefined>{
  const tx=db.transaction('appRecordMeta'),request=tx.objectStore('appRecordMeta').get(KEY),binding=tx.objectStore('appRecordMeta').get('recordSyncConnection');
  await new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error);});
  const value=request.result as LegacyImageSync|undefined;
  if(value&&(value.version!==1||!value.connection||!sameRecordSyncConnection(value.connection,connection)||!binding.result||!sameRecordSyncConnection(binding.result,connection)||!validImages(value.images)))throw new SyncProtocolError('connection_changed','旧画像の所有記録が一致しません。');
  return value;
}
export function queueLegacyImageSync(tx:IDBTransaction,connection:RecordSyncConnection,images:MissingSyncImage[]):void{
  if(!validImages(images))throw new Error('旧画像の参照を確認できません。');
  tx.objectStore('appRecordMeta').put({version:1,connection,images},KEY);
}
/** Consent covers only these original IDs and owners, never newly missing media. */
export function acceptsLegacyImages(missing:MissingSyncImage[],consent:LegacyImageSync|undefined):boolean{
  if(!consent)return false;
  const owners=new Map(consent.images.map(row=>[row.id,row.questionId]));
  return missing.every(row=>owners.get(row.id)===row.questionId);
}
