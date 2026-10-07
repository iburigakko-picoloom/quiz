import type { AppData } from '../types';
import { normalizeAppData } from './appDataValidation';
import { appRecordKey, rememberAppRecordChanges, validateState, type AppRecord, type AppRecordState, type AppOutboxOperation } from './appRecordStorage';
import { ExternalDataChangeError } from './dataCoordination';
import { queueUserEditGeneration } from './userEditGeneration';
import { recordSyncMetric } from './syncMetrics';

export type AnswerSaveChange = { previous: AppData; questionId: string; answerLogId: string };
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('回答を端末へ保存できませんでした。'));
});

/** Save a single appended answer. Unrelated records are never replaced from
 * the caller's view. Both the observed commit and exact prior study state are
 * checked before progress, history, undo, outbox and edit generation commit. */
export async function saveAnswerRecordChanges(db: IDBDatabase, data: AppData, savedAt: string, change: AnswerSaveChange): Promise<boolean> {
  const started = performance.now();
  const { previous, questionId, answerLogId } = change;
  if (data.version !== previous.version || data.folders !== previous.folders
    || data.problemSets !== previous.problemSets || data.questions !== previous.questions
    || data.answerLogs.length !== previous.answerLogs.length + 1
    || previous.answerLogs.some((row, index) => row !== data.answerLogs[index])) return false;
  const log = data.answerLogs[data.answerLogs.length - 1];
  const position = data.progress.findIndex(row => row.questionId === questionId);
  const priorPosition = previous.progress.findIndex(row => row.questionId === questionId);
  if (!log || log.id !== answerLogId || log.questionId !== questionId || position < 0
    || previous.answerLogs.some(row => row.id === answerLogId)
    || data.progress.length !== previous.progress.length + (priorPosition < 0 ? 1 : 0)
    || (priorPosition >= 0 && position !== priorPosition)
    || (priorPosition < 0 && position !== previous.progress.length)
    || previous.progress.some((row, index) => index !== priorPosition && row !== data.progress[index])) return false;
  const question = previous.questions.find(row => row.id === questionId);
  const set = previous.problemSets.find(row => row.id === question?.setId);
  const folder = previous.folders.find(row => row.id === set?.folderId);
  if (!question || !set || !folder) return false;
  // Run the existing canonical validators on this answer's references only.
  const base = { version: 1, folders: [folder], problemSets: [set], questions: [question] };
  const initial = normalizeAppData({ ...base, progress: [], answerLogs: [] });
  const before = normalizeAppData({ ...base, progress: priorPosition < 0 ? [] : [previous.progress[priorPosition]], answerLogs: [] });
  const next = normalizeAppData({ ...base, progress: [data.progress[position]], answerLogs: [log] });
  if (!initial.ok || !before.ok || !next.ok || next.data.answerLogs.length !== 1) return false;
  const progress = next.data.progress[0], answer = next.data.answerLogs[0];
  const progressKey = appRecordKey('progress', questionId), answerKey = appRecordKey('answerLogs', answerLogId);
  const read = db.transaction(['appRecordMeta', 'appRecords'], 'readonly'), readDone = done(read);
  const stateRequest = read.objectStore('appRecordMeta').get('state');
  const rows = read.objectStore('appRecords');
  const questionRequest = rows.get(appRecordKey('questions', questionId));
  const setRequest = rows.get(appRecordKey('problemSets', set.id));
  const progressRequest = rows.get(progressKey), answerRequest = rows.get(answerKey);
  await readDone;
  const state = stateRequest.result as AppRecordState | undefined;
  if (!state) return false; // Initial/legacy saves still establish the full manifest.
  validateState(state);
  for (const [key, request] of [[appRecordKey('questions', questionId), questionRequest],
    [appRecordKey('problemSets', set.id), setRequest], [progressKey, progressRequest], [answerKey, answerRequest]] as const) {
    const row = request.result as AppRecord | undefined;
    if (row && (row.key !== key || row.key !== appRecordKey(row.collection, row.id)
      || !(row.raw === null || typeof row.raw === 'string') || !Number.isSafeInteger(row.position) || row.position < 0
      || !Number.isSafeInteger(row.serverRevision) || row.serverRevision < 0
      || !Number.isSafeInteger(row.localRevision) || row.localRevision < 0 || row.localRevision > state.revision)) {
      throw new Error('回答対象の保存レコードを検証できません。');
    }
  }
  const oldProgress = progressRequest.result as AppRecord | undefined;
  if (questionRequest.result?.raw !== JSON.stringify(before.data.questions[0])
    || setRequest.result?.raw !== JSON.stringify(before.data.problemSets[0])
    || state.counts.answerLogs !== previous.answerLogs.length || answerRequest.result?.raw
    || (oldProgress?.raw && oldProgress.raw !== JSON.stringify(before.data.progress[0]))
    || (!oldProgress?.raw && JSON.stringify(before.data.progress[0]) !== JSON.stringify(initial.data.progress[0]))) throw new ExternalDataChangeError();
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('保存Revisionの上限に達しました。');
  const changes: AppRecord[] = [
    { key: progressKey, collection: 'progress', id: questionId, raw: JSON.stringify(progress),
      position: oldProgress?.position ?? position, serverRevision: oldProgress?.serverRevision ?? 0, localRevision: revision },
    { key: answerKey, collection: 'answerLogs', id: answerLogId, raw: JSON.stringify(answer),
      position: state.counts.answerLogs, serverRevision: answerRequest.result?.serverRevision ?? 0, localRevision: revision },
  ];
  const nextState: AppRecordState = { ...state, revision, savedAt, commitId: crypto.randomUUID(),
    counts: { ...state.counts, progress: state.counts.progress + (oldProgress?.raw ? 0 : 1), answerLogs: state.counts.answerLogs + 1 } };
  const tx = db.transaction(['appRecordMeta', 'appRecords', 'appRecordBackups', 'appOutbox'], 'readwrite'), completion = done(tx);
  let failure: unknown;
  const current = tx.objectStore('appRecordMeta').get('state');
  current.onsuccess = () => {
    try {
      if (current.result?.commitId !== state.commitId) throw new ExternalDataChangeError();
      for (const row of changes) {
        const prior = row.collection === 'progress' ? oldProgress : answerRequest.result as AppRecord | undefined;
        if (prior) tx.objectStore('appRecordBackups').put({ ...prior, replacedAt: revision }, row.key);
        tx.objectStore('appRecords').put(row, row.key);
        const pending = tx.objectStore('appOutbox').get(row.key);
        pending.onsuccess = () => {
          try {
            const old = pending.result as AppOutboxOperation | undefined;
            const baseContent = old ? (old.baseRevision === row.serverRevision ? old.baseContent : undefined)
              : prior && prior.serverRevision > 0 ? { raw: prior.raw, position: prior.position } : undefined;
            tx.objectStore('appOutbox').put({ operationId: crypto.randomUUID(), key: row.key, collection: row.collection,
              id: row.id, raw: row.raw, position: row.position, baseRevision: row.serverRevision, localRevision: revision,
              ...(baseContent ? { baseContent } : {}) } satisfies AppOutboxOperation, row.key);
          } catch (error) { failure = error; tx.abort(); }
        };
      }
      tx.objectStore('appRecordMeta').put(state, 'previousState');
      tx.objectStore('appRecordMeta').put(nextState, 'state');
      queueUserEditGeneration(tx);
    } catch (error) { failure = error; tx.abort(); }
  };
  try { await completion; } catch (error) { throw failure ?? error; }
  rememberAppRecordChanges(db, state.commitId, nextState, changes);
  recordSyncMetric('answerRecordCommit', performance.now() - started);
  changes.forEach(row => recordSyncMetric('recordWrite', 0, row.raw?.length ?? 0));
  return true;
}
