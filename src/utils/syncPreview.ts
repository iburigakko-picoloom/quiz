import { computePayloadDigest, computePayloadHash, downloadSyncData, exportQuizMakeData, getLastSyncState, getRemoteSyncMeta, getStoredSyncId, type RemoteSyncRecord, type SyncPayload } from './syncService';
import { materialComparisonPayload } from './materialCloud';

export type SyncPreview = { local: SyncPayload; remote: RemoteSyncRecord | null; syncId: string; same: boolean; localHash: string };

/** Read-only preview. Unchanged, strongly verified revisions need no body download.
 * Any destructive action must still fetch/revalidate its own snapshot. */
export async function readSyncPreview(syncId: string): Promise<SyncPreview> {
  const [local, meta] = await Promise.all([exportQuizMakeData(), getRemoteSyncMeta(syncId)]);
  if (!meta.ok) throw new Error(meta.error);
  const baseline = getLastSyncState();
  const localHash = computePayloadHash(local);
  const checkConnection = () => {
    if (getStoredSyncId().trim() !== syncId) throw new Error('同期先が変わりました。確認し直してください。');
  };
  checkConnection();
  if (!meta.value) return { local, remote: null, syncId, same: false, localHash };
  if (baseline.lastSyncDigest && meta.value.updatedAt === baseline.lastSyncAt
    && await computePayloadDigest(local) === baseline.lastSyncDigest) {
    checkConnection();
    return { local, remote: { syncId, updatedAt: meta.value.updatedAt, payload: local }, syncId, same: true, localHash };
  }
  const remote = await downloadSyncData(syncId, { materialFiles: 'references' });
  if (!remote.ok) throw new Error(remote.error);
  const [localComparable, remoteComparable] = await Promise.all([
    materialComparisonPayload(local), remote.value ? materialComparisonPayload(remote.value.payload) : null,
  ]);
  const same = remoteComparable !== null && await computePayloadDigest(localComparable) === await computePayloadDigest(remoteComparable);
  checkConnection();
  return { local, remote: remote.value, syncId, same, localHash };
}
