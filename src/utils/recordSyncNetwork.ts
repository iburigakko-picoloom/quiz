import type { RecordSyncTransport } from './recordSyncEngine';
import type { RecordSyncConnection } from './recordSyncOutbox';

export type RecordSyncAccess = { userId: string; accessToken: string };
export type RecordRpcOptions = {
  url: string;
  anonKey: string;
  connection: RecordSyncConnection;
  access(): Promise<RecordSyncAccess>;
  assertCurrent(): void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onRequest?: (operation: 'open' | 'pull' | 'push') => void;
};
export class RecordSyncRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RecordSyncRpcError'; this.code = code; }
}

/** Every request revalidates the authenticated account; a timeout never implies
 * that a push failed to commit. Its caller retains the frozen Operation IDs.
 */
export function createRecordSyncRpc(options: RecordRpcOptions): RecordSyncTransport & { open(expectedUpdatedAt: string): Promise<number> } {
  const origin = new URL(options.url).origin;
  if (origin !== options.connection.project) throw new Error('差分同期のプロジェクトが一致しません。');
  const request = async (name: string, body: Record<string, unknown>) => {
    options.assertCurrent();
    try { options.onRequest?.(name.endsWith('_push') ? 'push' : name.endsWith('_pull') ? 'pull' : 'open'); } catch { /* Informational only. */ }
    const access = await options.access();
    options.assertCurrent();
    if (access.userId !== options.connection.userId || !access.accessToken) throw new Error('差分同期中にアカウントが変わりました。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const response = await (options.fetch ?? fetch)(`${origin}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: options.anonKey, Authorization: `Bearer ${access.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_sync_id: options.connection.syncId, ...body }), signal: controller.signal,
        redirect: 'error',
      });
      options.assertCurrent();
      if (!response.ok) {
        // Do not embed server responses or credentials in user-facing logs.
        const code = response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'authentication_required'
          : response.status === 404 ? 'unavailable' : response.status === 413 ? 'payload_too_large'
          : response.status === 400 ? 'invalid_request' : 'network';
        throw new RecordSyncRpcError(code, `差分同期に失敗しました（HTTP ${response.status}）。端末データを保持しています。`);
      }
      const result: unknown = await response.json();
      options.assertCurrent();
      if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'string') throw new RecordSyncRpcError('invalid_response', '差分同期の応答を確認できませんでした。');
      return result as { code: string; [key: string]: unknown };
    } finally { clearTimeout(timer); }
  };
  return {
    async open(expectedUpdatedAt) {
      if (!Number.isFinite(Date.parse(expectedUpdatedAt))) throw new Error('初回同期のSnapshotを確認できませんでした。');
      const result = await request('quiz_sync_v2_open', { p_expected_updated_at: expectedUpdatedAt });
      if (result.code !== 'ok') throw new RecordSyncRpcError(result.code, '初回同期のSnapshotが変わりました。もう一度読み込んでください。');
      if (!('revision' in result) || !Number.isSafeInteger(result.revision) || (result.revision as number) < 0) throw new RecordSyncRpcError('invalid_response', '初回同期のRevisionが不正です。');
      return result.revision as number;
    },
    pull: cursor => request('quiz_sync_v2_pull', { p_cursor: cursor, p_limit: 20 }),
    push: operations => request('quiz_sync_v2_push', { p_operations: operations }),
  };
}
