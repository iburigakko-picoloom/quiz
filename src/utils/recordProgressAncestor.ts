import type { AnswerLog, QuestionProgress } from '../types';
import type { AppOutboxOperation, AppRecord } from './appRecordStorage';
import { appRecordKey } from './appRecordStorage';
import { advanceAnswerProgress, createInitialProgress } from './quiz';

type Incoming = { key: string; collection: string; id: string; raw: string | null; revision: number; position: number };
type EventRow = { id: string; raw: string | null; position: number };
export type ProgressSyncContext = {
  records: Map<string, AppRecord>; incomingByKey: Map<string, Incoming>;
  localLogs: Map<string, AppRecord[]>; remoteLogs: Map<string, Incoming[]>; hasDeletedHistory: boolean;
  pending: Map<string, AppOutboxOperation>;
};

/** Build per-question history once, including large initial migrations. */
export function createProgressSyncContext(records: Map<string, AppRecord>, incoming: Incoming[], outbox: AppOutboxOperation[] = []): ProgressSyncContext {
  const context: ProgressSyncContext = { records, incomingByKey: new Map(incoming.map(row => [row.key, row])),
    localLogs: new Map(), remoteLogs: new Map(), hasDeletedHistory: false, pending: new Map(outbox.map(row => [row.key, row])) };
  for (const row of records.values()) if (row.collection === 'answerLogs') {
    if (!row.raw) { context.hasDeletedHistory = true; continue; }
    const id = JSON.parse(row.raw).questionId;
    const logs = context.localLogs.get(id) ?? []; logs.push(row); context.localLogs.set(id, logs);
    // Only immutable, acknowledged events can complete a later remote delta.
    if (row.serverRevision > 0 && !context.pending.has(row.key) && !context.incomingByKey.has(row.key)) {
      const remote = context.remoteLogs.get(id) ?? [];
      remote.push({ ...row, revision: row.serverRevision }); context.remoteLogs.set(id, remote);
    }
  }
  for (const row of incoming) if (row.collection === 'answerLogs') {
    if (!row.raw) context.hasDeletedHistory = true;
    const raw = row.raw ?? records.get(row.key)?.raw;
    if (!raw) continue;
    const id = JSON.parse(raw).questionId;
    const logs = context.remoteLogs.get(id) ?? []; logs.push(row); context.remoteLogs.set(id, logs);
  }
  return context;
}

function replayHistory(question: { setId: string; choices: string[] }, questionId: string, rows: EventRow[]):
  { progress: QuestionProgress; eventIds: string[] } | null {
  let progress = createInitialProgress(questionId);
  let previousTime = Number.NEGATIVE_INFINITY;
  const eventIds = new Set<string>();
  for (const row of rows.slice().sort((a, b) => Date.parse(JSON.parse(a.raw!).answeredAt)
    - Date.parse(JSON.parse(b.raw!).answeredAt) || a.position - b.position || a.id.localeCompare(b.id))) {
    const log = JSON.parse(row.raw!) as AnswerLog;
    const time = Date.parse(log.answeredAt);
    if (log.id !== row.id || eventIds.has(log.id) || log.questionId !== questionId
      || log.setId !== question.setId || !Number.isFinite(time) || time < previousTime
      || typeof log.isCorrect !== 'boolean' || !Number.isInteger(log.selectedIndex)
      || log.selectedIndex < -1 || log.selectedIndex >= question.choices.length) return null;
    previousTime = time;
    eventIds.add(log.id);
    progress = advanceAnswerProgress(progress, log.selectedIndex, log.isCorrect, log.answeredAt);
  }
  return { progress, eventIds: [...eventIds] };
}

/** Every field on both branches and the acknowledged ancestor must replay
 * exactly. Missing/deleted/edited history and manual flags remain conflicts.
 */
export function verifiedBootstrapProgress(
  local: AppRecord, remote: Incoming, operation: AppOutboxOperation,
  context: ProgressSyncContext, startCursor: number,
  same: (collection: 'progress' | 'questions' | 'answerLogs', left: string | null, right: string | null) => boolean,
): { raw: string; choice: 'local' | 'remote' | 'merged'; eventIds: string[] } | null {
  if (remote.collection !== 'progress' || !local.raw || !remote.raw || operation.raw !== local.raw) return null;
  const bootstrap = startCursor === 0 && operation.baseRevision === 0 && local.serverRevision === 0;
  if (!bootstrap && (!operation.baseContent?.raw || operation.baseRevision < 1)) return null;
  const questionKey = appRecordKey('questions', remote.id);
  const localQuestion = context.records.get(questionKey);
  const remoteQuestion = context.incomingByKey.get(questionKey)
    ?? (!bootstrap && localQuestion?.serverRevision && !context.pending.has(questionKey) ? localQuestion : null);
  if (!localQuestion?.raw || !remoteQuestion?.raw
    || !same('questions', localQuestion.raw, remoteQuestion.raw)) return null;
  // A tombstone may be a reset whose original question ID is no longer known.
  if (context.hasDeletedHistory) return null;
  const localLogs = context.localLogs.get(remote.id) ?? [];
  const remoteLogs = context.remoteLogs.get(remote.id) ?? [];
  if (bootstrap && (localLogs.some(row => row.serverRevision !== 0)
    || (!localLogs.length && (local.localRevision !== 1 || operation.localRevision !== 1))
    || (!remoteLogs.length && remote.revision !== 1))) return null;
  if (!bootstrap && localLogs.some(row => context.pending.get(row.key)?.baseRevision)) return null;
  const question = JSON.parse(localQuestion.raw);
  const localReplay = replayHistory(question, remote.id, localLogs);
  const remoteReplay = replayHistory(question, remote.id, remoteLogs);
  if (!localReplay || !remoteReplay || !same('progress', local.raw, JSON.stringify(localReplay.progress))
    || !same('progress', remote.raw, JSON.stringify(remoteReplay.progress))) return null;
  if (!bootstrap) {
    const baseLogs = localLogs.filter(row => row.serverRevision > 0 && row.serverRevision <= operation.baseRevision);
    const baseReplay = replayHistory(question, remote.id, baseLogs);
    if (!baseReplay || !same('progress', operation.baseContent!.raw, JSON.stringify(baseReplay.progress))) return null;
    const remoteById = new Map(remoteLogs.map(row => [row.id, row]));
    if (baseLogs.some(row => !same('answerLogs', row.raw, remoteById.get(row.id)?.raw ?? null))) return null;
  }
  const events = new Map<string, EventRow>();
  for (const event of [...localLogs, ...remoteLogs]) {
    const old = events.get(event.id);
    if (old && !same('answerLogs', old.raw, event.raw)) return null;
    events.set(event.id, event);
  }
  // Preserve a single branch's order. For independent branches use the stable
  // event timestamp/ID order; replay, rather than max/add, derives every field.
  const localIds = new Set(localReplay.eventIds), remoteIds = new Set(remoteReplay.eventIds);
  let ordered: EventRow[];
  if ([...remoteIds].every(id => localIds.has(id))) {
    const shared = replayHistory(question, remote.id, localLogs.filter(row => remoteIds.has(row.id)));
    if (!shared || !same('progress', remote.raw, JSON.stringify(shared.progress))) return null;
    ordered = localLogs;
  } else if ([...localIds].every(id => remoteIds.has(id))) {
    const shared = replayHistory(question, remote.id, remoteLogs.filter(row => localIds.has(row.id)));
    if (!shared || !same('progress', local.raw, JSON.stringify(shared.progress))) return null;
    ordered = remoteLogs;
  }
  else {
    ordered = [...events.values()].sort((a, b) => Date.parse(JSON.parse(a.raw!).answeredAt)
      - Date.parse(JSON.parse(b.raw!).answeredAt) || a.id.localeCompare(b.id));
    for (let index = 1; index < ordered.length; index++) {
      const left = JSON.parse(ordered[index - 1].raw!) as AnswerLog, right = JSON.parse(ordered[index].raw!) as AnswerLog;
      // Independent events with indistinguishable times must not invent which
      // outcome/selection was last. Identical transitions commute at that time.
      if (Date.parse(left.answeredAt) === Date.parse(right.answeredAt)
        && (left.isCorrect !== right.isCorrect || left.selectedIndex !== right.selectedIndex)) return null;
    }
    ordered = ordered.map((row, position) => ({ ...row, position }));
  }
  const merged = replayHistory(question, remote.id, ordered);
  if (!merged) return null;
  const raw = JSON.stringify(merged.progress);
  return { raw, choice: same('progress', local.raw, raw) ? 'local' : same('progress', remote.raw, raw) ? 'remote' : 'merged',
    eventIds: merged.eventIds };
}
