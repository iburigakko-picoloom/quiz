import type { AnswerLog, QuestionProgress } from '../types';
import type { AppOutboxOperation, AppRecord } from './appRecordStorage';
export const LEARNING_EVENT_PREFIX = 'quizMake:sync-event:';
/** Persist non-coalescing intent beside the ordinary UI projection. Device clock
 * times describe answers; server commit order determines conflicting edits. */
export function queueLearningEvent(tx: IDBTransaction, revision: number, before: QuestionProgress | undefined, after: QuestionProgress | undefined, answer?: AnswerLog): AppRecord | undefined {
  if (!after || (!answer && JSON.stringify(before) === JSON.stringify(after))) return;
  const patch: Record<string, unknown> = {};
  const reset = Boolean(before && !answer && ['answeredCount','correctCount','wrongCount','lastSelectedIndex','lastAnswerCorrect','lastAnsweredAt'].some(field => before[field as keyof QuestionProgress] !== after[field as keyof QuestionProgress]));
  if (!answer) for (const field of ['isReview', 'isAmbiguous', 'reviewLevel', 'isGraduated', 'isStudyCompleted'] as const) {
    if (before?.[field] !== after[field]) patch[field] = after[field] ?? null;
  }
  if (!answer && !reset && before && !Object.keys(patch).length) return;
  const id = LEARNING_EVENT_PREFIX + crypto.randomUUID(), key = JSON.stringify(['localStorage', id]);
  const raw = JSON.stringify({ kind: 'quiz-learning-event', version: 1, questionId: after.questionId,
    action: answer ? 'answer' : reset ? 'reset' : before ? 'patch' : 'initialize',
    ...(answer ? { answer } : reset || !before ? { value: after } : { patch }) });
  const row: AppRecord = { key, id, collection: 'localStorage', raw, position: 0, localRevision: revision, serverRevision: 0 };
  const enabled = tx.objectStore('appRecordMeta').get('deltaEnabled');
  enabled.onsuccess = () => { if (enabled.result) {
    tx.objectStore('appRecords').put(row, key);
    tx.objectStore('appOutbox').put({ ...row, operationId: crypto.randomUUID(), baseRevision: 0 } satisfies AppOutboxOperation, key);
  } };
  return undefined;
}
