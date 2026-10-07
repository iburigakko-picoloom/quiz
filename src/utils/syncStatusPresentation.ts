import type { RecordSyncStatus } from './recordSyncStatus';
import type { SyncAttemptStatus } from './syncAttemptStatus';
export function syncStatusPresentation(input: { online: boolean; loginRequired: boolean; error: boolean; readError?: boolean; attempt?: SyncAttemptStatus | null; autoEnabled: boolean; recordEnabled: boolean; record: RecordSyncStatus | null; pending: boolean; success: string; now?: number }) {
  if (!input.online) return { text: 'オフライン', action: null } as const;
  if (input.readError) return { text: '同期状態を確認できません', action: 'retry' } as const;
  const attempt = input.attempt;
  if (attempt?.phase === 'running') return { text: attempt.step === 'authentication' ? '認証を確認しています' : '同期中', action: null } as const;
  if (attempt?.pauseReason === 'permission_denied') return { text: '同期先の権限を確認してください', action: 'retry' } as const;
  if (attempt?.pauseReason === 'local_persistence_failed') return { text: '端末への保存を確認してください', action: 'retry' } as const;
  if (attempt?.phase === 'paused' && attempt.lastFailure && attempt.pauseReason === attempt.lastFailure.code) return { text: '同期データの確認が必要です', action: 'retry' } as const;
  if (attempt?.phase === 'queued') {
    if (attempt.lastFailure?.code === 'authentication_required' && attempt.retryAt) return { text: 'ログインが必要です', action: 'login' } as const;
    if (attempt.retryAt) return { text: attempt.retryAt > (input.now ?? Date.now()) ? '再試行を待っています' : '再試行できます', action: 'retry' } as const;
    return { text: '同期を待っています', action: null } as const;
  }
  if ((attempt?.phase === 'failed' && attempt.lastFailure?.code === 'authentication_required') || ((!attempt || attempt.phase === 'failed') && input.loginRequired)) return { text: 'ログインが必要です', action: 'login' } as const;
  // A retained conflict is an actionable choice, not a connection failure.
  if (input.recordEnabled && input.record?.conflicts) return { text: '変更の確認があります', action: null } as const;
  if (attempt?.phase === 'paused' && attempt.pauseReason !== 'disabled') return { text: attempt.pauseReason === 'protected_work' ? '内容の確認後に同期を再開します' : '変更の反映を待っています', action: null } as const;
  if (attempt?.phase === 'failed' || (!attempt && input.error)) return { text: '同期できませんでした', action: 'retry' } as const;
  if (!input.autoEnabled) return { text: '自動同期はOFFです', action: 'retry' } as const;
  if (input.pending || input.record?.pending || input.record?.staged || ['more', 'deferred'].includes(input.record?.phase ?? '')) return { text: '同期中', action: null } as const;
  return { text: input.success ? '同期済み' : '同期中', action: null } as const;
}
