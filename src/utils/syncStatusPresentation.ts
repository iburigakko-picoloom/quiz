import type { RecordSyncStatus } from './recordSyncStatus';
export function syncStatusPresentation(input: { online: boolean; loginRequired: boolean; error: boolean; autoEnabled: boolean; recordEnabled: boolean; record: RecordSyncStatus | null; pending: boolean; success: string }) {
  if (!input.online) return { text: 'オフライン', action: null } as const;
  if (input.loginRequired) return { text: 'ログインが必要です', action: 'login' } as const;
  // A retained conflict is an actionable choice, not a connection failure.
  if (input.recordEnabled && input.record?.conflicts) return { text: '変更の確認があります', action: null } as const;
  if (input.error) return { text: '同期できませんでした', action: 'retry' } as const;
  if (!input.autoEnabled) return { text: '自動同期はOFFです', action: 'retry' } as const;
  if (input.pending || input.record?.pending || input.record?.staged || ['more', 'deferred'].includes(input.record?.phase ?? '')) return { text: '同期中', action: null } as const;
  return { text: input.success ? '同期済み' : '同期中', action: null } as const;
}
