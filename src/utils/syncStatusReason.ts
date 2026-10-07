import type { SyncAttemptStatus } from './syncAttemptStatus';
import { safeSyncFailureMessage } from './syncFailureDiagnostic';

export function syncStatusReason(attempt: SyncAttemptStatus | null, conflicts: number, readError: string, lastError: string): string {
  if (readError) return '端末の同期履歴を読み出せません。データを残したまま再試行してください。';
  if (attempt?.phase === 'running' || attempt?.phase === 'queued' && !attempt.retryAt) return '';
  if (attempt?.phase === 'paused' && attempt.pauseReason === 'protected_work') return conflicts ? 'この端末とクラウドの両方に変更があります。下で同期に使う側を選ぶと再開します。' : '入力中・内容の選択中のため、書き換えを一時停止しています。画面の操作を終えると再開します。';
  const failure = attempt?.lastFailure;
  const activeFailure = failure && (attempt?.phase === 'failed' || attempt?.phase === 'paused' && attempt.pauseReason === failure.code || attempt?.phase === 'queued' && attempt.retryAt);
  if (activeFailure) {
    if (failure.message.includes('クラウドの画像・教材を完全') || failure.message.includes('クラウドの参照関係')) return '選んだクラウド側に、読み込めない教材や画像があります。「この端末」を優先して同期することもできます。';
    if (failure.message.includes('完全な復元コピー') || failure.message.includes('この端末の画像・教材を完全')) return '選んだ端末側の画像・資料を読み出せません。もう一方のデータを選ぶか、原本の保存状態を確認してください。';
    if (failure.code === 'local_persistence_failed' || failure.code === 'quota') return '端末への保存、または原本のバックアップに失敗しました。空き容量を確保して再試行してください。';
    if (failure.code === 'authentication_required') return 'ログインの有効期限が切れています。同じアカウントでログインし直してください。';
    if (failure.code === 'permission_denied') return 'ログイン中のアカウントに、この保存先へアクセスする権限がありません。';
    if (failure.code === 'network' || failure.code === 'timeout') return '通信が途切れたか、サーバーの応答が遅れています。途中の送信内容を保持して再試行します。';
    if (failure.code === 'rate_limited') return '短時間の通信回数が上限に達しました。少し待ってから自動で再試行します。';
    if (failure.code === 'payload_too_large') return '送信するデータが1件または全体の容量上限を超えています。';
    if (failure.code === 'media_pending' || failure.code === 'media_unsupported') return '画像またはPDFの本体を保存・確認できません。もう一方のデータを選ぶか、資料の保存状態を確認してください。';
    if (failure.code === 'remote_changed' || failure.code === 'local_changed' || failure.code === 'conflict') return '同期中にデータが更新されました。選んだ側を優先して、最新の内容で再試行します。';
    if (failure.code === 'invalid_response' || failure.code === 'invalid') return '選んだ側のデータに、欠けた参照や読めない内容があります。別の側を選び直せます。';
    const safe=safeSyncFailureMessage(failure.message);
    return safe==='詳細な理由を安全に表示できません。端末データは保持しています。' ? `「${syncStageLabel(failure.step)}」の処理を完了できませんでした。再試行しても続く場合は、詳細設定の同期情報を確認してください。` : safe;
  }
  if (conflicts || attempt?.pauseReason === 'conflict') return 'この端末とクラウドの両方に変更があります。下の選択肢で、同期に使う側を選んでください。';
  if (attempt?.pauseReason === 'deferred') return 'ほかの画面で保存中のため、反映を待っています。保存が終わると再開します。';
  return lastError ? safeSyncFailureMessage(lastError) : '';
}

export function syncStageLabel(step: string): string {
  const labels: Record<string,string> = {authentication:'ログインを確認中',remote_metadata:'クラウドの状態を確認中',open:'保存先を確認中',materials:'資料を送信中',images:'画像を送信中',records:'教材を照合中',pull:'クラウドを読み込み中',push:'データを送信中',receipt:'保存結果を確認中',backup:'原本をバックアップ中'};
  return labels[step] ?? '同期の準備中';
}
