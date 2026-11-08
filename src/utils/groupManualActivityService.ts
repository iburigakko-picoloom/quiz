import { getCachedCloudAccountIdentity, groupProgressRpc } from './cloudService';
import { assertAccountNetworkCurrent, sameLocalAccount, type LocalAccountIdentity } from './accountStorage';
import { drainManualActivities, manualActivityOutbox, type ManualActivity } from './groupManualActivityOutbox';
export const MANUAL_ACTIVITY_UPDATED = 'quizmake:manual-activity-updated';
export async function retryManualActivities(identity = getCachedCloudAccountIdentity()) {
  if (!identity) return;
  try {
    await drainManualActivities(identity, async row => {
      assertAccountNetworkCurrent(identity);
      return await groupProgressRpc('quiz_group_manual_activity_publish', { p_group_id: row.groupId, p_generation: row.generation, p_event_id: row.id, p_title: row.title, p_answered: row.answered, p_minutes: row.minutes, p_finished_at: row.finishedAt }, identity.userId) as boolean;
    });
  } finally { window.dispatchEvent(new Event(MANUAL_ACTIVITY_UPDATED)); }
}
export async function queueManualActivity(identity: LocalAccountIdentity, row: ManualActivity) {
  if (!sameLocalAccount(identity, getCachedCloudAccountIdentity())) throw new Error('アカウントが変更されました。');
  assertAccountNetworkCurrent(identity);
  await manualActivityOutbox(identity).put(row);
  try { await retryManualActivities(identity); } catch { /* The durable outbox retains failed sends. */ }
  try { const item = (await manualActivityOutbox(identity).list()).find(item => item.row.id === row.id); return item?.status ?? 'sent'; }
  catch { return 'pending' as const; }
}
