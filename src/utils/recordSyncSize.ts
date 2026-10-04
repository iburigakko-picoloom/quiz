import { SyncProtocolError } from './syncInterruption';

export const MAX_RECORD_BATCH_BYTES = 900 * 1024;
export const SYNC_RECORD_KIND_LABELS = [
  '学習計画', '今日の計画目標', '手書きノート', 'ノート管理情報', '苦手メモ一覧',
  '解説の依頼履歴', '削除済みメモ', '問題', '回答履歴', '復習状態', '教材情報',
  'フォルダ情報', '画像参照', '資料・ノート', '端末設定',
] as const;
type RecordKind = typeof SYNC_RECORD_KIND_LABELS[number];

function recordKind(collection: string, id: string): RecordKind {
  if (collection === 'localStorage') {
    if (id.startsWith('quizMake:plan:')) return '学習計画';
    if (id.startsWith('quizMake:planDay:')) return '今日の計画目標';
    if (id === 'quiz-make-creation-notes-v1') return '苦手メモ一覧';
    if (id === 'quiz-make-explanation-requests-v1') return '解説の依頼履歴';
    if (id === 'quiz-make-creation-notes-v1-removed-orphans') return '削除済みメモ';
    if (id.startsWith('quiz-make-note-storage-v1:')) return 'ノート管理情報';
  }
  if (collection === 'indexedDbNotes') {
    return id.startsWith('quizMake:notes:') && !id.includes(':__material_')
      ? '手書きノート' : '資料・ノート';
  }
  const labels: Record<string, RecordKind> = {
    questions: '問題', answerLogs: '回答履歴', progress: '復習状態',
    problemSets: '教材情報', folders: 'フォルダ情報', questionImages: '画像参照',
  };
  return Object.prototype.hasOwnProperty.call(labels, collection) ? labels[collection] : '端末設定';
}

/** Contains only a static kind and a byte count; never record keys, content or credentials. */
export class SyncRecordTooLargeError extends SyncProtocolError {
  readonly recordKind: RecordKind;
  readonly requiredBytes: number;
  readonly limitBytes = MAX_RECORD_BATCH_BYTES;

  constructor(collection: string, id: string, requiredBytes: number) {
    const kind = recordKind(collection, id);
    super('payload_too_large', `1レコードの同期サイズが大きすぎます（対象：${kind}、計算サイズ：${requiredBytes}B、上限：${MAX_RECORD_BATCH_BYTES}B）。データは端末に保持しています。`);
    this.name = 'SyncRecordTooLargeError';
    this.recordKind = kind;
    this.requiredBytes = requiredBytes;
  }
}
