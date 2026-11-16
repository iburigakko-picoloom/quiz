/** A rejected transaction is a sync failure, not a failure to load local data.
 * Only block editing when committed data could not be published to the UI. */
export async function applyAndPublishRecords<T extends { applied: boolean }>(
  apply: () => Promise<T>,
  publish: (result: T) => Promise<void>,
  onPublicationFailure: (error: unknown) => void,
): Promise<T> {
  const result = await apply();
  if (result.applied) {
    try { await publish(result); }
    catch (error) { onPublicationFailure(error); throw error; }
  }
  return result;
}
