export type AppSaveStage = 'validation' | 'coordination' | 'indexeddb' | 'fallback';
export type AppSaveFailure = {
  code: 'invalid_data' | 'external_change' | 'lock_timeout' | 'quota' | 'storage_blocked' | 'storage_write';
  attempts: Array<{ stage: AppSaveStage; errorName: string }>;
  validationReason?: string;
};
const names = new Set(['Error', 'QuotaExceededError', 'AbortError', 'DataCloneError', 'InvalidStateError',
  'VersionError', 'SecurityError', 'UnknownError', 'ConstraintError', 'DataError', 'TransactionInactiveError',
  'ExternalDataChangeError', 'CrossContextLockUnavailableError', 'DataLockTimeoutError']);
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'cause' in error && error.cause) return errorName(error.cause);
  return error instanceof Error && names.has(error.name) ? error.name : 'Error';
}
/** Never include question text, IDs, answers, paths or credentials in diagnostics. */
export function appSaveFailure(attempts: Array<{ stage: AppSaveStage; error: unknown }>, validationReason?: string): AppSaveFailure {
  const safe = attempts.map(item => ({ stage: item.stage, errorName: errorName(item.error) }));
  const primary = safe.find(item => item.stage !== 'fallback') ?? safe[0];
  const code = primary?.stage === 'validation' ? 'invalid_data'
    : primary?.errorName === 'ExternalDataChangeError' ? 'external_change'
    : primary?.errorName === 'DataLockTimeoutError' ? 'lock_timeout'
    : primary?.errorName === 'QuotaExceededError' ? 'quota'
    : primary?.errorName === 'SecurityError' ? 'storage_blocked' : 'storage_write';
  // Normalizer messages describe a field; remove any echoed record ID.
  const reason = validationReason ? safeSyncFailureMessage(validationReason) : undefined;
  return { code, attempts: safe, ...(reason ? { validationReason: reason } : {}) };
}
export function appSaveFailureMessage(failure: AppSaveFailure): string {
  const reason = failure.code === 'invalid_data' ? `問題データの形式を確認できません。${failure.validationReason ?? '入力内容を確認してください。'}`
    : failure.code === 'external_change' ? '別の画面でデータが更新されました。入力内容を控えて、画面を開き直してください。'
    : failure.code === 'lock_timeout' ? '別のQuizMake画面の保存処理を待っています。入力内容を控えて、ほかのQuizMake画面を閉じてからもう一度保存してください。'
    : failure.code === 'quota' ? 'ブラウザの保存容量を確保できません。入力内容を控えて、保存設定と空き容量を確認してください。'
    : failure.code === 'storage_blocked' ? 'ブラウザが端末への保存を許可していません。保存設定を確認してください。'
    : '端末の保存処理を完了できません。入力内容を控えて、もう一度保存してください。';
  return `${reason} 保存前のデータは保持しています。確認コード: ${failure.attempts.map(item => `${item.stage}/${item.errorName}`).join(' + ')}`;
}
import { safeSyncFailureMessage } from './syncFailureDiagnostic';
