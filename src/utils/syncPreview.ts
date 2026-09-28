import { computePayloadDigest, computePayloadHash, downloadSyncData, exportQuizMakeData, getLastSyncState, getRemoteSyncMeta, getStoredSyncId, type RemoteSyncMeta, type RemoteSyncRecord, type SyncPayload } from './syncService';
import { materialComparisonPayload } from './materialCloud';

export type SyncPreview = { local: SyncPayload; remote: RemoteSyncRecord | null; syncId: string; same: boolean; localHash: string };
export type SyncOverviewState = 'same' | 'local' | 'cloud' | 'conflict';
export type SyncOverview = {
  local: SyncPayload;
  remote: RemoteSyncMeta | null;
  syncId: string;
  state: SyncOverviewState;
  detailed?: SyncPreview;
};

/** The everyday status check never transfers the remote body with a strong baseline.
 * An older/unknown baseline needs the complete comparison before a direction is shown. */
export async function readSyncOverview(syncId: string): Promise<SyncOverview> {
  const [local, meta] = await Promise.all([exportQuizMakeData(), getRemoteSyncMeta(syncId)]);
  if (!meta.ok) throw new Error(meta.error);
  if (getStoredSyncId().trim() !== syncId) throw new Error('同期先が変わりました。確認し直してください。');
  if (!meta.value) return { local, remote: null, syncId, state: 'local' };

  const baseline = getLastSyncState();
  if (!baseline.lastSyncAt || !baseline.lastSyncDigest) {
    const detailed = await compareSyncSnapshot(syncId, local, meta.value);
    return {
      local: detailed.local,
      remote: detailed.remote,
      syncId,
      state: detailed.same ? 'same' : 'conflict',
      detailed,
    };
  }

  const localChanged = await computePayloadDigest(local) !== baseline.lastSyncDigest;
  if (getStoredSyncId().trim() !== syncId) throw new Error('同期先が変わりました。確認し直してください。');
  const remoteChanged = meta.value.updatedAt !== baseline.lastSyncAt;
  const state: SyncOverviewState = localChanged && remoteChanged ? 'conflict'
    : remoteChanged ? 'cloud'
      : localChanged ? 'local' : 'same';
  return { local, remote: meta.value, syncId, state };
}

/** Read-only preview. Unchanged, strongly verified revisions need no body download.
 * Any destructive action must still fetch/revalidate its own snapshot. */
export async function readSyncPreview(syncId: string): Promise<SyncPreview> {
  const [local, meta] = await Promise.all([exportQuizMakeData(), getRemoteSyncMeta(syncId)]);
  if (!meta.ok) throw new Error(meta.error);
  return compareSyncSnapshot(syncId, local, meta.value);
}

async function compareSyncSnapshot(syncId: string, local: SyncPayload, remoteMeta: RemoteSyncMeta | null): Promise<SyncPreview> {
  const baseline = getLastSyncState();
  const localHash = computePayloadHash(local);
  const checkConnection = () => {
    if (getStoredSyncId().trim() !== syncId) throw new Error('同期先が変わりました。確認し直してください。');
  };
  checkConnection();
  if (!remoteMeta) return { local, remote: null, syncId, same: false, localHash };
  if (baseline.lastSyncDigest && remoteMeta.updatedAt === baseline.lastSyncAt
    && await computePayloadDigest(local) === baseline.lastSyncDigest) {
    checkConnection();
    return { local, remote: { syncId, updatedAt: remoteMeta.updatedAt, payload: local }, syncId, same: true, localHash };
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
