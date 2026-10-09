import type { SyncAttemptStatus, SyncFailure } from './syncAttemptStatus';
import { safeSyncFailureMessage } from './syncFailureDiagnostic';

export function syncFailureReason(failure:SyncFailure):string {
  if(failure.code==='material_reference'&&failure.diagnostic?.referenceIssues?.length){
    const reason=failure.diagnostic.referenceIssues[0].reason;
    if(reason==='missing_material'||reason==='missing_page')return '参照先の資料・ページが見つかりません。同期情報を確認し、保存元のバックアップから資料を復旧してください。';
    if(reason==='ambiguous_material')return '同じ資料IDが複数の教材にあります。同期情報で対象を確認してください。';
    return '資料一覧と教材の対応を確認できません。同期情報で対象を確認してください。';
  }
  const typed:Record<string,string>={pdf_download:'PDFの取得に失敗しました。再試行してください。',pdf_missing:'PDF本体が見つかりません。保存元の端末を確認してください。',pdf_integrity:'PDFの内容を検証できませんでした。',material_reference:'資料の紐づけ情報に不備があります。',image_missing:'一部の画像を確認できません。',image_reference:'一部の画像の紐づけ情報を確認できません。',note_integrity:'ノートの保存状態を確認できません。',backup_integrity:'バックアップの内容を検証できませんでした。',storage_capacity:'端末への保存容量が不足しています。',memory_limit:'同期データを処理するメモリが不足しています。'};
  if(typed[failure.code])return typed[failure.code];
  const message=failure.message;
  if(/^クラウドの画像[1-9][0-9]{0,5}件の紐づけ情報がありません。$/u.test(message))return message;
  if(message.includes('クラウドの画像・教材を完全')||message.includes('クラウドの参照関係')){
    const cause=message.includes('原本を保持しています。')?message.split('原本を保持しています。')[1]:message;
    if(message.includes('クラウドの参照関係')||cause.includes('存在しない問題セット')||cause.includes('存在しないフォルダ')||cause.includes('参照が壊れ'))return 'クラウドの教材の紐づけ情報に不備があります。';
    if(cause.includes('画像・PDF・資料'))return 'クラウドの教材・画像を読み込めません。';
    if(cause.includes('PDF'))return 'クラウドのPDFを読み込めません。';
    if(cause.includes('画像'))return 'クラウドの画像を読み込めません。';
    return 'クラウドの教材・画像を読み込めません。';
  }
  if(message.includes('完全な復元コピー')||message.includes('この端末の画像・教材を完全'))return '端末の画像・資料を読み込めません。';
  const reasons:Record<string,string>={
    local_persistence_failed:'端末に保存できません。空き容量を確認してください。',quota:'クラウドの保存容量が上限に達しました。',
    authentication_required:'ログインを確認できません。ログインし直してください。',permission_denied:'この保存先へのアクセス権限がありません。',
    network:'通信に失敗しました。再試行してください。',timeout:'通信が時間切れになりました。再試行してください。',rate_limited:'通信回数の上限に達しました。少し待つと再開します。',
    server_timeout:'クラウドの保存処理が時間切れになりました。再試行します。',
    payload_too_large:'同期データが容量上限を超えています。',media_pending:'画像・PDFの保存が終わっていません。',media_unsupported:'画像・PDFの形式を確認できません。',
    remote_changed:'クラウドが更新されました。再試行します。',local_changed:'端末が更新されました。再試行します。',conflict:'端末とクラウドの両方に変更があります。',
    invalid_response:'同期データを読み込めません。',invalid:'同期データの形式に不備があります。',
  };
  if(reasons[failure.code])return reasons[failure.code];
  const safe=safeSyncFailureMessage(message);
  return safe==='詳細な理由を安全に表示できません。端末データは保持しています。'?`「${syncStageLabel(failure.step)}」で失敗しました。`:safe.split('。')[0]+'。';
}
export function syncStatusReason(attempt:SyncAttemptStatus|null,conflicts:number,readError:string,lastError:string):string {
  if(readError)return '端末の同期履歴を読み出せません。';
  if(attempt?.phase==='running'||attempt?.phase==='queued'&&!attempt.retryAt)return '';
  if(attempt?.phase==='paused'&&attempt.pauseReason==='protected_work')return conflicts?'同期に使うデータを選んでください。':'操作が終わると同期を再開します。';
  const failure=attempt?.lastFailure;
  if(failure&&(attempt?.phase==='failed'||attempt?.phase==='paused'&&attempt.pauseReason===failure.code||attempt?.phase==='queued'&&attempt.retryAt))return syncFailureReason(failure);
  if(conflicts||attempt?.pauseReason==='conflict')return '端末とクラウドの両方に変更があります。';
  if(attempt?.pauseReason==='deferred')return '保存が終わると同期を再開します。';
  return lastError?'同期に失敗しました。詳細設定で確認できます。':'';
}

export function syncStageLabel(step: string): string {
  const labels: Record<string,string> = {authentication:'ログインを確認中',remote_metadata:'クラウドの状態を確認中',open:'保存先を確認中',materials:'資料を送信中',images:'画像を送信中',records:'教材を照合中',pull:'クラウドを読み込み中',push:'データを送信中',receipt:'保存結果を確認中',backup:'原本をバックアップ中'};
  return labels[step] ?? '同期の準備中';
}
