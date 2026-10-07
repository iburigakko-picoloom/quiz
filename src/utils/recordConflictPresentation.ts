import type { AppRecord } from './appRecordStorage';
import { appRecordKey } from './appRecordStorage';
import type { RecordConflict } from './recordSyncPull';
import { auxiliaryRecordLabel, conflictPreview } from './recordConflictComparison';

const labels = { folders: 'フォルダー', problemSets: '問題集', questions: '問題', progress: '回答・復習の状態',
  answerLogs: '回答履歴', localStorage: '設定・補助データ', indexedDbNotes: 'ノート・資料', questionImages: '問題の画像' };
const valueOf = (raw: string | null | undefined): Record<string, unknown> | null => {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const text = (value: unknown) => typeof value === 'string' ? conflictPreview(value).slice(0, 160) : '';

export function recordConflictTitle(item: RecordConflict, records: Map<string, AppRecord>): string {
  const value = valueOf(item.local?.logicalRaw ?? item.local?.raw) ?? valueOf(item.remote.logicalRaw ?? item.remote.raw);
  if (item.remote.collection === 'localStorage') return `${auxiliaryRecordLabel(item.remote.id)}${item.remote.id.startsWith('quizMake:plan:') && text(value?.title) ? `：${text(value?.title)}` : ''}`;
  const questionId = item.remote.collection === 'progress' || item.remote.collection === 'questions'
    ? item.remote.id : typeof value?.questionId === 'string' ? value.questionId : null;
  const question = questionId ? valueOf(records.get(appRecordKey('questions', questionId))?.raw) : null;
  const setId = question?.setId ?? (item.remote.collection === 'problemSets' ? item.remote.id : null);
  const set = typeof setId === 'string' ? valueOf(records.get(appRecordKey('problemSets', setId))?.raw) : null;
  const subject = text(question?.question) || text(value?.question) || text(value?.title) || text(value?.name);
  const context = subject && text(set?.title) && item.remote.collection !== 'problemSets' ? `${text(set?.title)} / ` : '';
  return `${labels[item.remote.collection]}${subject ? `：${context}${subject}` : ''}`;
}

export function describeRecordConflictValue(raw: string | null): string {
  if (raw === null) return '削除';
  const value = valueOf(raw);
  if (typeof value?.answeredCount === 'number') {
    const state = value.isGraduated ? '復習を卒業' : value.isReview ? `復習レベル ${value.reviewLevel ?? 1}` : '復習なし';
    const last = value.lastAnswerCorrect === true ? '最終回答は正解' : value.lastAnswerCorrect === false ? '最終回答は不正解' : '最終回答なし';
    return `回答 ${value.answeredCount}回・正解 ${value.correctCount ?? 0}回・不正解 ${value.wrongCount ?? 0}回 / ${state}${value.isAmbiguous ? '・あやふや' : ''} / ${last}`;
  }
  if (typeof value?.question === 'string') {
    const choices = Array.isArray(value.choices) ? text(value.choices.join(' / ')) : '';
    return `問題：${text(value.question)}${choices ? ` / 選択肢：${choices}` : ''}${value.answerText ? ` / 正解：${text(value.answerText)}` : ''}${value.explanation ? ` / 解説：${text(value.explanation)}` : ''}`;
  }
  if (typeof value?.body === 'string') return text(value.body);
  if (typeof value?.title === 'string') return text(value.title);
  if (typeof value?.name === 'string') return text(value.name);
  if (Array.isArray(value?.pages)) return `ノート ${value.pages.length}ページ`;
  if (typeof value?.isCorrect === 'boolean') return `回答履歴：${value.isCorrect ? '正解' : '不正解'} (${text(value.answeredAt)})`;
  return `保存データ ${raw.length}文字`;
}

export const recordConflictIdentity = (item: RecordConflict): string => JSON.stringify([
  item.connection, item.key, item.operationId, item.remote.revision, item.local?.raw, item.remote.raw, item.local?.position, item.remote.position,
]);

/** Never carry a radio selection over to a newly edited competing version. */
export function retainRecordConflictChoices(previous: Map<string, string>, conflicts: RecordConflict[],
  choices: Record<string, 'local' | 'remote'>): Record<string, 'local' | 'remote'> {
  return Object.fromEntries(conflicts.filter(item => previous.get(item.key) === recordConflictIdentity(item) && choices[item.key])
    .map(item => [item.key, choices[item.key]]));
}
