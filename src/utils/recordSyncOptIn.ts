const RECORD_SYNC_OPT_IN_KEY = 'quizMake:sync:recordV2OptIn';

/** Opt-in is local to one connection. Missing or unreadable storage leaves V2 off. */
export function isRecordSyncOptedIn(syncId: string): boolean {
  if (!syncId) return false;
  try { return localStorage.getItem(RECORD_SYNC_OPT_IN_KEY) === syncId; }
  catch { return false; }
}

export function setRecordSyncOptIn(syncId: string, enabled: boolean): { ok: true } | { ok: false; error: string } {
  if (!syncId) return { ok: false, error: '同期先を接続してください。' };
  try {
    if (enabled) localStorage.setItem(RECORD_SYNC_OPT_IN_KEY, syncId);
    else localStorage.removeItem(RECORD_SYNC_OPT_IN_KEY);
    if (isRecordSyncOptedIn(syncId) !== enabled) throw new Error('設定を保存できませんでした。');
    window.dispatchEvent(new CustomEvent('quiz-make-sync-settings-change'));
    return { ok: true };
  } catch {
    if (enabled) {
      try { localStorage.removeItem(RECORD_SYNC_OPT_IN_KEY); } catch { /* Best effort. */ }
    }
    return { ok: false, error: '高速同期の設定を端末へ保存できませんでした。現在の設定を確認してください。' };
  }
}
