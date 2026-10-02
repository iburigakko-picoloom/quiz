import type { AppData, AnswerLog, Question, QuestionProgress } from '../types';
import { normalizeAppData } from './appDataValidation';
import { sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import type { RecordConflict } from './recordSyncPull';

export type ArchivedRecordConflict = { id: string; conflict: RecordConflict; savedAt: string; choice?: string };
export async function readArchivedRecordConflicts(db: IDBDatabase, connection: RecordSyncConnection): Promise<ArchivedRecordConflict[]> {
  const tx = db.transaction('appRecordConflicts', 'readonly');
  const completion = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('復旧用の原本を読み取れませんでした。')); });
  const store = tx.objectStore('appRecordConflicts');
  const values = store.getAll(); const keys = store.getAllKeys();
  await completion;
  return values.result.flatMap((item, index) => item.conflict?.connection && sameRecordSyncConnection(item.conflict.connection, connection)
    ? [{ id: String(keys.result[index]), conflict: item.conflict, savedAt: item.resolvedAt ?? item.archivedAt ?? '', choice: item.choice }] : [])
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Make a separate problem and progress copy. The current version and both raw
 * originals remain intact. Missing history is never synthesized or merged. */
export function createConflictRecoveryCopy(data: AppData, conflict: RecordConflict, side: 'local' | 'remote', now = new Date().toISOString()): AppData {
  const raw = side === 'local' ? conflict.local?.raw : conflict.remote.raw;
  if (!raw) throw new Error('削除された版は原本JSONで確認してください。');
  const value = JSON.parse(raw);
  const collection = conflict.remote.collection;
  const sourceId = collection === 'progress' || collection === 'questions' ? conflict.remote.id : value.questionId;
  const question = collection === 'questions' ? value as Question : data.questions.find(item => item.id === sourceId);
  if (!['questions', 'progress', 'answerLogs'].includes(collection) || !question) throw new Error('この内容は原本JSONを書き出して復旧してください。');
  // Preserve image/material IDs only on the existing problem. A separate copy
  // must not claim ownership of blobs or descriptors that have not been copied.
  if (question.questionImageIds?.length || question.detailedAnswer?.imageIds?.length || question.materialReferences?.length) throw new Error('画像・資料付きの内容は原本JSONを書き出して復旧してください。');
  const folderId = crypto.randomUUID(), setId = crypto.randomUUID(), questionId = crypto.randomUUID();
  const set = data.problemSets.find(item => item.id === question.setId);
  const copy: AppData = structuredClone(data);
  copy.folders.push({ id: folderId, name: '同期の復旧コピー', createdAt: now, updatedAt: now });
  copy.problemSets.push({ id: setId, folderId, title: `${set?.title ?? '問題'}（${side === 'local' ? '端末' : 'クラウド'}の復旧コピー）`, source: set?.source ?? '', creationMethod: 'copy', visibility: 'private', createdAt: now, updatedAt: now });
  copy.questions.push({ ...question, id: questionId, setId, createdAt: now, updatedAt: now });
  if (collection === 'progress') copy.progress.push({ ...value as QuestionProgress, questionId });
  if (collection === 'answerLogs') copy.answerLogs.push({ ...value as AnswerLog, id: crypto.randomUUID(), questionId, setId, folderId });
  const normalized = normalizeAppData(copy);
  if (!normalized.ok || normalized.data.questions.length !== copy.questions.length || normalized.data.answerLogs.length !== copy.answerLogs.length) throw new Error('復旧コピーの内容を検証できませんでした。原本は保持しています。');
  if (collection === 'progress') {
    const actual = normalized.data.progress.find(item => item.questionId === questionId);
    const expected = copy.progress.find(item => item.questionId === questionId);
    if (!actual || Object.keys(expected!).some(key => JSON.stringify(actual[key as keyof QuestionProgress]) !== JSON.stringify(expected![key as keyof QuestionProgress]))) throw new Error('学習状態を完全に復旧できません。原本JSONを確認してください。');
  }
  return normalized.data;
}
