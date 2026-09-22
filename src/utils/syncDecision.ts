/** Never use device wall clocks to decide which copy may overwrite the other. */
export function getSyncDecision(
  baseline: { lastSyncAt: string; lastSyncDigest?: string },
  localDigest: string,
  remote: { updatedAt: string; digest: string },
): 'same' | 'download' | 'upload' | 'confirm' {
  if (localDigest === remote.digest) return 'same';
  if (!baseline.lastSyncAt || !baseline.lastSyncDigest) return 'confirm';
  const localChanged = localDigest !== baseline.lastSyncDigest;
  const remoteChanged = remote.updatedAt !== baseline.lastSyncAt;
  if (localChanged && remoteChanged) return 'confirm';
  if (remoteChanged && !localChanged) return 'download';
  if (localChanged && !remoteChanged) return 'upload';
  // Same revision with a different payload is not a normal update.
  return 'confirm';
}
