export const CLOUD_UPDATE_EVENT = 'quiz-make-cloud-update-available';
export interface CloudUpdateNotice { syncId: string; updatedAt: string }
const dismissed = new Map<string, string>();
const key = (id: string) => `quiz-make-cloud-notice-dismissed:${id}`;
export function isCloudUpdateDismissed(notice: CloudUpdateNotice): boolean {
  if (dismissed.get(notice.syncId) === notice.updatedAt) return true;
  try { return localStorage.getItem(key(notice.syncId)) === notice.updatedAt; } catch { return false; }
}
export function dismissCloudUpdate(notice: CloudUpdateNotice) {
  dismissed.set(notice.syncId, notice.updatedAt);
  try { localStorage.setItem(key(notice.syncId), notice.updatedAt); } catch { /* Keep the dismissal for this session. */ }
}
