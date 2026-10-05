import type {RecordSyncConnection} from './recordSyncOutbox';
export interface WholeSyncBaseline {
  version:1; connection:RecordSyncConnection; serverRevision:number; userGeneration:number; digest:string;
}
export type WholeSyncDecision='same'|'upload'|'download'|'conflict';
/** Server revision and durable user generation establish the ancestor. Clock
 * values and record-level merges never select a winner. Reverted identical
 * content can be acknowledged without sending or replacing it again. */
export function decideWholeSync(value:{baseline?:WholeSyncBaseline;serverRevision:number;userGeneration:number;localDigest:string;remoteDigest:string;verifiedRecordCursor?:number}):WholeSyncDecision{
  if(value.localDigest===value.remoteDigest)return 'same';
  const base=value.baseline;
  if(!base){
    // An existing fully applied record cursor proves that the server has not
    // changed since this device saw it. Otherwise do not guess first-device
    // ownership or turn an unknown remote state into an empty one.
    return value.verifiedRecordCursor!==undefined&&value.verifiedRecordCursor===value.serverRevision?'upload':'conflict';
  }
  const local=value.userGeneration!==base.userGeneration&&value.localDigest!==base.digest;
  const remote=value.serverRevision!==base.serverRevision&&value.remoteDigest!==base.digest;
  if(local&&remote)return 'conflict';
  if(local)return 'upload';
  if(remote)return 'download';
  // A different body with unchanged witnesses means corruption/incomplete
  // initialization, rather than permission to overwrite an unseen copy.
  return 'conflict';
}
