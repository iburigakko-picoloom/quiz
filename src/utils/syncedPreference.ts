import { withCoordinatedDataMutation } from './dataCoordination';
import { saveSyncedLocalStorage } from './localStorageRecords';

/** Commit the preference and its dirty witness together before updating the UI. */
export async function saveSyncedPreference(key: string, value: string): Promise<void> {
  if (typeof indexedDB === 'undefined') { await saveSyncedLocalStorage({ [key]: value }); return; }
  await withCoordinatedDataMutation(['app'], () => saveSyncedLocalStorage({ [key]: value }), { requireCrossContext: true });
}
