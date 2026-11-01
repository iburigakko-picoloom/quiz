import { SyncDataError, type MaterialReferenceIssue } from './syncDataIntegrity';

export type AppSaveStage = 'validation' | 'coordination' | 'indexeddb' | 'fallback' | 'material_reference';
export type AppSaveFailure = {
  code: 'invalid_data' | 'external_change' | 'lock_timeout' | 'quota' | 'storage_blocked' | 'storage_write' | 'material_reference' | 'material_read';
  attempts: Array<{ stage: AppSaveStage; errorName: string }>;
  validationReason?: string;
  referenceIssue?: MaterialReferenceIssue['reason'];
};
const names = new Set(['Error', 'QuotaExceededError', 'AbortError', 'DataCloneError', 'InvalidStateError',
  'VersionError', 'SecurityError', 'UnknownError', 'ConstraintError', 'DataError', 'TransactionInactiveError',
  'ExternalDataChangeError', 'CrossContextLockUnavailableError', 'DataLockTimeoutError',
  'SyncDataError', 'CategoryNoteStorageTimeoutError', 'CategoryNoteRecoveryRequiredError']);
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

const referenceMessages: Record<MaterialReferenceIssue['reason'], string> = {
  invalid_index: '資料一覧の形式を確認できません。教材の資料一覧を確認してください。',
  index_identity: '資料一覧と教材の対応を確認できません。教材の資料一覧を確認してください。',
  missing_owner: '参照元の教材が見つかりません。参照先を選び直してください。',
  missing_material: '参照先の資料が見つかりません。元の教材の資料を確認してください。',
  missing_page: '参照先のページが見つかりません。参照ページを選び直してください。',
  ambiguous_material: '参照先の資料IDが複数の教材で重複しています。教材の資料一覧を確認してください。',
  missing_pdf: '参照先のPDF本体が見つかりません。元の教材でPDFを確認してください。',
  invalid_pdf: '参照先のPDFの内容を確認できません。元の教材でPDFを確認してください。',
  unhydrated_pdf: '参照先のPDFの受信が完了していません。PDFを読み込んでから保存してください。',
};

/** Keep the cause category, never record IDs, user content or raw exceptions. */
export function materialReferenceSaveFailure(error: unknown): AppSaveFailure {
  const failure = appSaveFailure([{ stage: 'material_reference', error }]);
  const issue = error instanceof SyncDataError ? error.diagnostic.referenceIssues?.[0]?.reason : undefined;
  if (issue && Object.prototype.hasOwnProperty.call(referenceMessages, issue)) {
    return { ...failure, code: 'material_reference', referenceIssue: issue, validationReason: referenceMessages[issue] };
  }
  return failure.code === 'storage_write' ? { ...failure, code: 'material_read' } : failure;
}

export function appSaveFailureMessage(failure: AppSaveFailure): string {
  const reason = failure.code === 'material_reference' ? (failure.referenceIssue ? referenceMessages[failure.referenceIssue] : '参照先の資料を確認できません。')
    : failure.code === 'material_read' ? '参照先を確認するための資料データを読み取れません。教材の資料を開いて保存状態を確認し、もう一度保存してください。'
    : failure.code === 'invalid_data' ? `問題データの形式を確認できません。${failure.validationReason ?? '入力内容を確認してください。'}`
    : failure.code === 'external_change' ? '別の画面でデータが更新されました。入力内容を控えて、画面を開き直してください。'
    : failure.code === 'lock_timeout' ? '別のQuizMake画面の保存処理を待っています。入力内容を控えて、ほかのQuizMake画面を閉じてからもう一度保存してください。'
    : failure.code === 'quota' ? 'ブラウザの保存容量を確保できません。入力内容を控えて、保存設定と空き容量を確認してください。'
    : failure.code === 'storage_blocked' ? 'ブラウザが端末への保存を許可していません。保存設定を確認してください。'
    : '端末の保存処理を完了できません。入力内容を控えて、もう一度保存してください。';
  return `${reason} 保存前のデータは保持しています。確認コード: ${failure.attempts.map(item => `${item.stage}/${item.errorName}`).join(' + ')}${failure.referenceIssue ? `/${failure.referenceIssue}` : ''}`;
}
import { safeSyncFailureMessage } from './syncFailureDiagnostic';
