import type { AppData } from '../types';
import {
  APP_COLLECTIONS, RECORD_COLLECTIONS, appRecordKey, materializeAppRecords, readAppRecordSnapshotForCommit, readCachedAppRecordData,
  rememberAppRecordData, rememberAppRecordSnapshot,
  type AppRecord, type AppOutboxOperation, type RecordCollection,
} from './appRecordStorage';
import { bindRecordSyncConnection, sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import { recordSyncMetric } from './syncMetrics';
import { NOTE_CURRENT_STORE, NOTE_BACKUP_STORE } from './auxiliaryRecordStorage';
import { LOCAL_PROJECTION_STORE } from './localStorageRecords';
import { PULL_IMAGE_STORE, parseQuestionImageDescriptor } from './recordQuestionImageSync';
import { storedQuestionImage, verifyQuestionImageBlob } from './questionImageCloud';
import type { QuestionImageDescriptor, StoredQuestionImage } from './questionImageRecords';
import { normalizeAppData } from './appDataValidation';
import { createProgressSyncContext, verifiedBootstrapProgress } from './recordProgressAncestor';

export type RemoteRecordChange = { key: string; collection: RecordCollection; id: string; raw: string | null; position: number; revision: number };
export type RecordPullPage = { code: 'ok'; cursor: number; head: number; hasMore: boolean; batches: Array<{ revision: number; changes: RemoteRecordChange[] }> };
type PullState = { connection: RecordSyncConnection; startCursor: number; cursor: number; head: number };
export type RecordConflict = { key: string; connection: RecordSyncConnection; local: AppRecord | null; remote: RemoteRecordChange; operationId: string | null };
export type RecordConflictDecision = { key: string; operationId: string; remoteRevision: number; choice: 'local' | 'remote' };
export type RecordPullApplyOptions = { preserveLiveData?: boolean };

export async function readActiveRecordConflicts(db: IDBDatabase, connection: RecordSyncConnection): Promise<RecordConflict[]> {
  const tx = db.transaction(['appRecordMeta','appRecordConflicts'],'readonly');
  const completion = done(tx);
  const stage = tx.objectStore('appRecordMeta').get('pullStage');
  const rows = tx.objectStore('appRecordConflicts').getAll();
  await completion;
  if (!stage.result || !sameRecordSyncConnection(stage.result.connection,connection)) return [];
  return (rows.result as unknown[]).filter((value): value is RecordConflict => {
    const item = value as RecordConflict;
    return Boolean(item && typeof item.key === 'string' && item.remote && typeof item.operationId === 'string'
      && sameRecordSyncConnection(item.connection,connection));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('差分読込を確定できませんでした。')); });
}
const revisionValid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Exported for the network adapter: never trust cursor progress or record IDs from a response. */
export function validateRecordPullPage(value: unknown, fromCursor: number): RecordPullPage {
  const page = value as RecordPullPage | null;
  if (!page || page.code !== 'ok' || !revisionValid(page.cursor) || !revisionValid(page.head)
    || page.cursor < fromCursor || page.cursor > page.head || page.hasMore !== (page.cursor < page.head)
    || !Array.isArray(page.batches) || page.batches.length > 20) throw new Error('差分読込のCursorが不正です。');
  let cursor = fromCursor;
  const batches = page.batches.map(batch => {
    if (!batch || batch.revision !== cursor + 1 || !Array.isArray(batch.changes) || !batch.changes.length) throw new Error('差分読込の変更履歴が連続していません。');
    cursor = batch.revision;
    const seen = new Set<string>();
    const changes = batch.changes.map(row => {
      if (!row || !RECORD_COLLECTIONS.includes(row.collection) || typeof row.id !== 'string' || !row.id
        || row.key !== appRecordKey(row.collection, row.id) || seen.has(row.key)
        || !(row.raw === null || typeof row.raw === 'string') || !Number.isSafeInteger(row.position) || row.position < 0
        || row.revision !== batch.revision) throw new Error('差分読込のレコードが不正です。');
      if (APP_COLLECTIONS.some(name => name === row.collection) && row.raw !== null) {
        const parsed = JSON.parse(row.raw);
        if (!parsed || typeof parsed !== 'object' || (row.collection === 'progress' ? parsed.questionId : parsed.id) !== row.id) throw new Error('差分読込のレコードIDが一致しません。');
      }
      seen.add(row.key);
      return { key: row.key, collection: row.collection, id: row.id, raw: row.raw, position: row.position, revision: row.revision };
    });
    return { revision: batch.revision, changes };
  });
  if (cursor !== page.cursor || (page.hasMore && !batches.length)) throw new Error('差分読込のCursorが変更内容と一致しません。');
  return { code: 'ok', cursor, head: page.head, hasMore: page.hasMore, batches };
}

export async function getRecordPullCursor(db: IDBDatabase, connection: RecordSyncConnection): Promise<number> {
  const tx = db.transaction('appRecordMeta', 'readonly');
  const completion = done(tx);
  const [stage, committed] = await Promise.all([
    request<PullState | undefined>(tx.objectStore('appRecordMeta').get('pullStage')),
    request<{ connection: RecordSyncConnection; cursor: number } | undefined>(tx.objectStore('appRecordMeta').get('pullCursor')), completion,
  ]);
  for (const item of [stage, committed]) if (item && !sameRecordSyncConnection(item.connection, connection)) throw new Error('読込中に同期先が変わりました。');
  return stage?.cursor ?? committed?.cursor ?? 0;
}

/** Staging and its resume cursor commit together. Live data is untouched until all pages arrive. */
export async function stageRecordPullPage(db: IDBDatabase, connection: RecordSyncConnection, fromCursor: number, value: unknown): Promise<void> {
  const page = validateRecordPullPage(value, fromCursor);
  await bindRecordSyncConnection(db, connection);
  const tx = db.transaction(['appRecordMeta', 'appPullStage'], 'readwrite');
  const completion = done(tx);
  let failure: unknown;
  const previous = tx.objectStore('appRecordMeta').get('pullStage');
  const committed = tx.objectStore('appRecordMeta').get('pullCursor');
  committed.onsuccess = () => {
    try {
      const stage = previous.result as PullState | undefined;
      const baseline = committed.result as { connection: RecordSyncConnection; cursor: number } | undefined;
      for (const item of [stage, baseline]) if (item && !sameRecordSyncConnection(item.connection, connection)) throw new Error('読込中に同期先が変わりました。');
      if ((stage?.cursor ?? baseline?.cursor ?? 0) !== fromCursor || (stage && page.head < stage.head)) throw new Error('別のタブで差分読込が進みました。');
      page.batches.forEach(batch => batch.changes.forEach(row => tx.objectStore('appPullStage').put(row, row.key)));
      tx.objectStore('appRecordMeta').put({ connection, startCursor: stage?.startCursor ?? fromCursor, cursor: page.cursor, head: page.head } satisfies PullState, 'pullStage');
    } catch (error) { failure = error; tx.abort(); }
  };
  try { await completion; } catch (error) { throw failure ?? error; }
  recordSyncMetric('pullPageStaged', 0, new TextEncoder().encode(JSON.stringify(page)).byteLength);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}
export function sameRecordContent(collection: RecordCollection, left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null || collection === 'localStorage' || collection === 'indexedDbNotes') return false;
  return JSON.stringify(stableValue(JSON.parse(left))) === JSON.stringify(stableValue(JSON.parse(right)));
}

/** Answer-only Pull can validate its changed rows against the already validated
 * question graph. Other imports still run the complete normalization path. */
function materializeAnswerChanges(db: IDBDatabase, commitId: string, writes: AppRecord[], next: Map<string, AppRecord>): AppData | null {
  if (!writes.every(row => row.collection === 'progress' || row.collection === 'answerLogs')) return null;
  const previous = readCachedAppRecordData(db, commitId);
  if (!previous) return null;
  const questions = new Map(previous.questions.map((row, index) => [row.id, { row, index }]));
  const sets = new Map(previous.problemSets.map(row => [row.id, row]));
  const folders = new Map(previous.folders.map(row => [row.id, row]));
  const progress = previous.progress.slice();
  const logs = new Map(previous.answerLogs.map(row => [row.id, row]));
  for (const change of writes) {
    const value = change.raw === null ? null : JSON.parse(change.raw);
    if (change.collection === 'answerLogs' && !value && !logs.has(change.id)) continue;
    const questionId = change.collection === 'progress' ? change.id : (value?.questionId ?? logs.get(change.id)?.questionId);
    const question = questions.get(questionId);
    if (!question) throw new Error('差分レコードが存在しない問題を参照しています。');
    const set = sets.get(question.row.setId);
    const folder = set && folders.get(set.folderId);
    if (!set || !folder) throw new Error('差分レコードの参照が壊れています。');
    const normalized = normalizeAppData({ version: 1, folders: [folder], problemSets: [set], questions: [question.row],
      progress: change.collection === 'progress' && value ? [value] : [],
      answerLogs: change.collection === 'answerLogs' && value ? [value] : [] });
    if (!normalized.ok) throw new Error(normalized.error);
    if (change.collection === 'progress') progress[question.index] = normalized.data.progress[0];
    else if (value) {
      if (normalized.data.answerLogs.length !== 1) throw new Error('差分回答履歴の参照が壊れています。');
      logs.set(change.id, normalized.data.answerLogs[0]);
    } else logs.delete(change.id);
  }
  const orderedLogs = [...next.values()].filter(row => row.collection === 'answerLogs' && row.raw !== null)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(row => {
      const log = logs.get(row.id);
      if (!log) throw new Error('差分回答履歴の一部が失われています。');
      return log;
    });
  return { ...previous, progress, answerLogs: orderedLogs };
}

/** Caller holds the origin data lock and has checked protected work and queued saves. */
export async function applyStagedRecordPull(
  db: IDBDatabase, connection: RecordSyncConnection, decisions: RecordConflictDecision[] = [],
  options: RecordPullApplyOptions = {},
): Promise<{ applied: true; data?: AppData; cursor: number; changed: number; commitId: string }
  | { applied: false; conflicts: RecordConflict[] } | { applied: false; deferred: true; commitId: string; pushBlocked?: boolean }> {
  if (options.preserveLiveData && decisions.length) throw new Error('作業中は競合の選択を適用できません。');
  const startedAt = performance.now();
  const readTx = db.transaction(['appRecordMeta', 'appPullStage'], 'readonly');
  const readDone = done(readTx);
  const [stage, incoming, inflight, initialState] = await Promise.all([
    request<PullState | undefined>(readTx.objectStore('appRecordMeta').get('pullStage')),
    request<RemoteRecordChange[]>(readTx.objectStore('appPullStage').getAll()),
    request(readTx.objectStore('appRecordMeta').get('pushBatch')),
    request(readTx.objectStore('appRecordMeta').get('state')), readDone,
  ]);
  if (!stage || !sameRecordSyncConnection(stage.connection, connection) || stage.cursor !== stage.head) throw new Error('差分読込の全ページが揃っていません。');
  if (inflight) throw new Error('未確認の送信結果を確認してから差分を取り込んでください。');
  if (!initialState) throw new Error('端末のレコード移行が完了していません。');
  if (!incoming.length) {
    if (decisions.length) throw new Error('競合の内容が更新されました。もう一度内容を確認してください。');
    const tx = db.transaction(['appRecordMeta', 'appPullStage'], 'readwrite');
    const completion = done(tx);
    const current = tx.objectStore('appRecordMeta').get('pullStage');
    current.onsuccess = () => {
      if (JSON.stringify(current.result) !== JSON.stringify(stage)) { tx.abort(); return; }
      tx.objectStore('appRecordMeta').put({ connection, cursor: stage.cursor }, 'pullCursor');
      tx.objectStore('appRecordMeta').delete('pullStage');
    };
    await completion;
    recordSyncMetric('pullUnchanged');
    return { applied: true, cursor: stage.cursor, changed: 0, commitId: initialState.commitId };
  }
  const pendingTx = db.transaction('appOutbox', 'readonly'); const pendingDone = done(pendingTx);
  const operations = await Promise.all(incoming.map(row => request<AppOutboxOperation | undefined>(pendingTx.objectStore('appOutbox').get(row.key))));
  await pendingDone;
  const before = await readAppRecordSnapshotForCommit(db, initialState.commitId);
  if (!before || before.state.commitId !== initialState.commitId) throw new Error('差分読込中に端末が更新されました。');
  const readAt = performance.now();
  const pending = new Map(operations.filter((op): op is AppOutboxOperation => Boolean(op)).map(op => [op.key, op]));
  const selected = new Map(decisions.map(decision => [decision.key, decision]));
  if (selected.size !== decisions.length || decisions.some(decision => !['local', 'remote'].includes(decision.choice))) throw new Error('競合の選択が不正です。');
  const revision = before.state.revision + 1;
  const next = new Map(before.records);
  const writes: AppRecord[] = [];
  const clearPending: string[] = [];
  const conflicts: RecordConflict[] = [];
  const resolved: Array<{ conflict: RecordConflict; choice: 'local' | 'remote' | 'merged';
    reason?: 'unchanged-ancestor' | 'bootstrap-answer-history'; eventIds?: string[] }> = [];
  const rebased: AppOutboxOperation[] = [];
  const progressContext = incoming.some(row => row.collection === 'progress' && pending.has(row.key))
    ? createProgressSyncContext(before.records, incoming) : null;
  for (const remote of incoming) {
    const local = before.records.get(remote.key);
    if (local && remote.revision < local.serverRevision) continue; // An acknowledged push can be newer than this page.
    const op = pending.get(remote.key);
    const remoteAnswerChanged = op && remote.collection === 'progress'
      && (progressContext?.hasDeletedHistory || progressContext?.remoteLogs.get(remote.id)?.some(row => row.revision > op.baseRevision));
    const novelRemoteEvent = op && remote.collection === 'progress' && progressContext?.remoteLogs.get(remote.id)?.some(row =>
      row.revision > op.baseRevision && !sameRecordContent('answerLogs', row.raw, before.records.get(row.key)?.raw ?? null));
    const differentLocalEvent = op && novelRemoteEvent && progressContext?.localLogs.get(remote.id)?.some(row =>
      row.serverRevision === 0 || row.serverRevision > op.baseRevision);
    const same = !differentLocalEvent && sameRecordContent(remote.collection, local?.raw ?? null, remote.raw) && (!local || local.position === remote.position);
    if (op && !same) {
      // A pull of the unchanged remote ancestor leaves an unsent local edit alone.
      if (remote.revision <= op.baseRevision) continue;
      const conflict = { key: remote.key, connection, local: local ?? null, remote, operationId: op.operationId };
      const unchangedAncestor = local && op.baseContent && !remoteAnswerChanged
        && op.baseContent.position === remote.position
        && sameRecordContent(remote.collection, op.baseContent.raw, remote.raw);
      const bootstrap = !unchangedAncestor && local && progressContext ? verifiedBootstrapProgress(
        local, remote, op, progressContext, stage.startCursor, sameRecordContent,
      ) : null;
      if (local && (unchangedAncestor || (bootstrap && bootstrap.choice !== 'remote'))) {
        // Preserve the exact local values; only advance their verified CAS base.
        // New operation IDs avoid rewriting an uncertain/idempotent request.
        const row = { ...local, raw: bootstrap?.raw ?? local.raw, localRevision: revision, serverRevision: remote.revision };
        next.set(row.key, row); writes.push(row);
        rebased.push({ ...op, raw: row.raw, operationId: crypto.randomUUID(), baseRevision: remote.revision, localRevision: revision,
          baseContent: { raw: remote.raw, position: remote.position } });
        resolved.push({ conflict, choice: bootstrap?.choice ?? 'local', reason: unchangedAncestor ? 'unchanged-ancestor' : 'bootstrap-answer-history',
          ...(bootstrap ? { eventIds: bootstrap.eventIds } : {}) });
        continue;
      }
      if (bootstrap) {
        resolved.push({ conflict, choice: 'remote', reason: 'bootstrap-answer-history', eventIds: bootstrap.eventIds });
      } else {
        const decision = selected.get(remote.key);
        if (!decision) { conflicts.push(conflict); continue; }
        if (decision.operationId !== op.operationId || decision.remoteRevision !== remote.revision) throw new Error('競合の内容が更新されました。もう一度内容を確認してください。');
        selected.delete(remote.key);
        resolved.push({ conflict, choice: decision.choice });
        if (decision.choice === 'local') {
          if (!local) throw new Error('競合の端末データを確認できませんでした。');
          const row = { ...local, localRevision: revision, serverRevision: remote.revision };
          next.set(row.key, row); writes.push(row);
          rebased.push({ ...op, operationId: crypto.randomUUID(), baseRevision: remote.revision, localRevision: revision,
            baseContent: { raw: remote.raw, position: remote.position } });
          continue;
        }
      }
    }
    if (op) clearPending.push(remote.key);
    if (local && same && local.serverRevision === remote.revision) continue;
    const row: AppRecord = { ...remote, raw: same && local ? local.raw : remote.raw, localRevision: revision, serverRevision: remote.revision };
    next.set(row.key, row); writes.push(row);
  }
  if (selected.size) throw new Error('競合の内容が更新されました。もう一度内容を確認してください。');
  const mediaByKey = new Map<string, { key: string; revision: number; descriptor: QuestionImageDescriptor; image: StoredQuestionImage }>();
  if (incoming.some(row => row.collection === 'questionImages' && row.raw !== null)) {
    const mediaTx = db.transaction(PULL_IMAGE_STORE, 'readonly'); const mediaDone = done(mediaTx);
    const media = await Promise.all(incoming.filter(row => row.collection === 'questionImages' && row.raw !== null)
      .map(row => request<{ key: string; revision: number; descriptor: QuestionImageDescriptor; image: StoredQuestionImage } | undefined>(mediaTx.objectStore(PULL_IMAGE_STORE).get(row.key))));
    await mediaDone;
    media.forEach(row => { if (row) mediaByKey.set(row.key, row); });
  }
  const locallySelected = new Set(resolved.filter(item => item.choice === 'local').map(item => item.conflict.key));
  const mediaWrites: Array<{ id: string; image: StoredQuestionImage | null }> = [];
  if (!conflicts.length) for (const remote of incoming) {
    if (remote.collection !== 'questionImages' || locallySelected.has(remote.key)) continue;
    const local = before.records.get(remote.key);
    const pendingOp = pending.get(remote.key);
    if ((local && remote.revision < local.serverRevision) || (pendingOp && remote.revision <= pendingOp.baseRevision)) continue;
    if (remote.raw === null) { mediaWrites.push({ id: remote.id, image: null }); continue; }
    const descriptor = parseQuestionImageDescriptor(remote.raw);
    const stagedMedia = mediaByKey.get(remote.key);
    if (!stagedMedia || stagedMedia.revision !== remote.revision || JSON.stringify(stagedMedia.descriptor) !== JSON.stringify(descriptor)) throw new Error('検証済みの画像本体が揃っていません。');
    mediaWrites.push({ id: remote.id, image: storedQuestionImage(descriptor, stagedMedia.image.blob) });
  }
  const counts = { ...before.state.counts };
  writes.forEach(row => {
    if (!APP_COLLECTIONS.some(name => name === row.collection)) return;
    const name = row.collection as typeof APP_COLLECTIONS[number];
    counts[name] += Number(row.raw !== null) - Number(before.records.get(row.key)?.raw != null);
  });
  const nextState = { ...before.state, revision, commitId: crypto.randomUUID(), savedAt: new Date().toISOString(), counts };
  // Validate all references before writing. An incomplete dependency change remains staged.
  const data = conflicts.length ? undefined :
    (materializeAnswerChanges(db, before.state.commitId, writes, next) ?? materializeAppRecords({ state: nextState, records: next }));
  if (data) {
    const changedQuestions = new Set(writes.filter(row => row.collection === 'questions').map(row => row.id));
    const changedImages = new Set(writes.filter(row => row.collection === 'questionImages').map(row => row.id));
    for (const question of changedQuestions.size || changedImages.size ? data.questions : []) {
      const ids = question.detailedAnswer?.imageIds ?? [];
      if (!changedQuestions.has(question.id) && !ids.some(id => changedImages.has(id))) continue;
      for (const id of ids) {
        const raw = next.get(appRecordKey('questionImages', id))?.raw;
        if (!raw || parseQuestionImageDescriptor(raw).questionId !== question.id) throw new Error('問題が参照する画像が揃っていません。差分読込は保留しました。');
      }
    }
  }
  const touchesImages = incoming.some(row => row.collection === 'questionImages');
  let needsLiveMedia = false;
  if (options.preserveLiveData && mediaWrites.length) {
    const tx = db.transaction('questionImageBlobs', 'readonly'); const completion = done(tx);
    const live = await Promise.all(mediaWrites.map(row => request<StoredQuestionImage | undefined>(tx.objectStore('questionImageBlobs').get(row.id))));
    await completion;
    for (let index = 0; index < mediaWrites.length; index++) {
      const target = mediaWrites[index], existing = live[index];
      if (!target.image) { needsLiveMedia ||= Boolean(existing); continue; }
      const descriptor = mediaByKey.get(appRecordKey('questionImages', target.id))!.descriptor;
      if (!existing || existing.id !== descriptor.id || existing.questionId !== descriptor.questionId
        || !(existing.blob instanceof Blob) || !await verifyQuestionImageBlob(existing.blob, descriptor)) needsLiveMedia = true;
    }
  }
  // Inspect the same merge (including conflicts, references and verified media)
  // during protected work, but leave every live value and projection untouched.
  // Server-revision-only changes and equal-content acknowledgements are safe.
  const deferLiveChanges = Boolean(options.preserveLiveData && (needsLiveMedia || writes.some(row => {
    const old = before.records.get(row.key);
    return row.raw !== (old?.raw ?? null) || (row.raw !== null && row.position !== old?.position);
  })));
  const safeResolved = resolved.filter(item => item.choice === 'local' && item.reason);
  const explicitKeys = new Set(resolved.filter(item => !item.reason).map(item => item.conflict.key));
  const safeWrites = writes.filter(row => {
    const old = before.records.get(row.key);
    return old && !explicitKeys.has(row.key) && old.raw === row.raw && old.position === row.position;
  });
  const safeKeys = new Set(safeWrites.map(row => row.key));
  const safeClearPending = clearPending.filter(key => {
    const old = before.records.get(key), row = next.get(key);
    return old && row && !explicitKeys.has(key) && old.raw === row.raw && old.position === row.position;
  });
  safeClearPending.forEach(key => safeKeys.add(key));
  const safeState = safeWrites.length ? { ...before.state, revision, commitId: crypto.randomUUID(), savedAt: nextState.savedAt } : before.state;
  const preparedAt = performance.now();
  const stores = deferLiveChanges
    ? ['appRecordMeta', 'appRecordConflicts']
    : ['appRecordMeta', 'appRecords', 'appRecordBackups', 'appPullStage', 'appRecordConflicts'];
  if (!deferLiveChanges) {
    if (clearPending.length || rebased.length) stores.push('appOutbox');
    if (writes.some(row => row.collection === 'indexedDbNotes')) stores.push(NOTE_CURRENT_STORE, NOTE_BACKUP_STORE);
    if (writes.some(row => row.collection === 'localStorage')) stores.push(LOCAL_PROJECTION_STORE);
    if (touchesImages) stores.push(PULL_IMAGE_STORE, 'questionImageBlobs');
  } else {
    if (safeWrites.length) stores.push('appRecords', 'appRecordBackups');
    if (safeClearPending.length || rebased.some(op => safeKeys.has(op.key))) stores.push('appOutbox');
  }
  const tx = db.transaction(stores, 'readwrite');
  const completion = done(tx);
  let failure: unknown;
  const current = tx.objectStore('appRecordMeta').get('state');
  const currentStage = tx.objectStore('appRecordMeta').get('pullStage');
  const currentPush = tx.objectStore('appRecordMeta').get('pushBatch');
  currentPush.onsuccess = () => {
    try {
      if (current.result?.commitId !== before.state.commitId || JSON.stringify(currentStage.result) !== JSON.stringify(stage) || currentPush.result) throw new Error('差分読込中に端末が更新されました。');
      const archiveActive = (key: string, replacement?: RecordConflict) => {
        const old = tx.objectStore('appRecordConflicts').get(key);
        old.onsuccess = () => {
          if (old.result && JSON.stringify(old.result) !== JSON.stringify(replacement)) {
            tx.objectStore('appRecordConflicts').put({ conflict: old.result, archivedAt: nextState.savedAt,
              reason: 'superseded' }, `resolved:${crypto.randomUUID()}`);
          }
        };
      };
      if (conflicts.length || deferLiveChanges) {
        // Verified ancestor rebases can commit independently of staged visible
        // changes. Raw values, positions, blobs and projections stay unchanged.
        safeWrites.forEach(row => {
          tx.objectStore('appRecordBackups').put({ ...before.records.get(row.key)!, replacedAt: revision }, row.key);
          tx.objectStore('appRecords').put(row, row.key);
        });
        rebased.filter(op => safeKeys.has(op.key)).forEach(op => tx.objectStore('appOutbox').put(op, op.key));
        safeClearPending.forEach(key => tx.objectStore('appOutbox').delete(key));
        if (safeWrites.length) {
          tx.objectStore('appRecordMeta').put(before.state, 'previousState');
          tx.objectStore('appRecordMeta').put(safeState, 'state');
        }
        safeKeys.forEach(key => {
          archiveActive(key);
          tx.objectStore('appRecordConflicts').delete(key);
        });
        safeResolved.forEach(item => {
          tx.objectStore('appRecordConflicts').put({ ...item, resolvedAt: nextState.savedAt }, `resolved:${crypto.randomUUID()}`);
        });
        conflicts.forEach(conflict => {
          archiveActive(conflict.key, conflict);
          tx.objectStore('appRecordConflicts').put(conflict, conflict.key);
        });
        return; // Retain the full stage and committed cursor for Home/restart.
      }
      writes.forEach(row => {
        const old = before.records.get(row.key);
        if (old) tx.objectStore('appRecordBackups').put({ ...old, replacedAt: revision }, row.key);
        tx.objectStore('appRecords').put(row, row.key);
        if (!options.preserveLiveData && row.collection === 'indexedDbNotes') {
          // The exact previous record is in appRecordBackups. Legacy note readers
          // select backups by timestamp, which must not undo a CAS-based import.
          tx.objectStore(NOTE_BACKUP_STORE).delete(row.id);
          if (row.raw === null) tx.objectStore(NOTE_CURRENT_STORE).delete(row.id);
          else tx.objectStore(NOTE_CURRENT_STORE).put(row.raw, row.id);
        }
        if (!options.preserveLiveData && row.collection === 'localStorage') tx.objectStore(LOCAL_PROJECTION_STORE).put(row.raw, row.id);
      });
      if (!options.preserveLiveData) mediaWrites.forEach(row => {
        if (row.image) tx.objectStore('questionImageBlobs').put(row.image, row.id);
        else tx.objectStore('questionImageBlobs').delete(row.id);
      });
      clearPending.forEach(key => tx.objectStore('appOutbox').delete(key));
      rebased.forEach(op => tx.objectStore('appOutbox').put(op, op.key));
      if (writes.length) {
        tx.objectStore('appRecordMeta').put(before.state, 'previousState');
        tx.objectStore('appRecordMeta').put(nextState, 'state');
      }
      tx.objectStore('appRecordMeta').put({ connection, cursor: stage.cursor }, 'pullCursor');
      tx.objectStore('appRecordMeta').delete('pullStage');
      tx.objectStore('appPullStage').clear();
      if (touchesImages) tx.objectStore(PULL_IMAGE_STORE).clear();
      incoming.forEach(row => {
        archiveActive(row.key);
        tx.objectStore('appRecordConflicts').delete(row.key);
      });
      // Keep both versions after an explicit decision, including the remote version
      // when the user retains the local edit. Never discard a rejected version.
      resolved.forEach(item => tx.objectStore('appRecordConflicts').put({ ...item, resolvedAt: nextState.savedAt }, `resolved:${crypto.randomUUID()}`));
    } catch (error) { failure = error; tx.abort(); }
  };
  try { await completion; } catch (error) { throw failure ?? error; }
  if ((conflicts.length || deferLiveChanges) && safeWrites.length) {
    const safeRecords = new Map(before.records);
    safeWrites.forEach(row => safeRecords.set(row.key, row));
    rememberAppRecordSnapshot(db, { state: safeState, records: safeRecords });
    const cached = readCachedAppRecordData(db, before.state.commitId);
    if (cached) rememberAppRecordData(db, safeState.commitId, cached);
  }
  if (conflicts.length) return { applied: false, conflicts };
  if (deferLiveChanges) return { applied: false, deferred: true, commitId: safeState.commitId,
    ...(resolved.some(item => item.reason && item.choice !== 'local') ? { pushBlocked: true } : {}) };
  if (writes.length) {
    rememberAppRecordSnapshot(db, { state: nextState, records: next });
    rememberAppRecordData(db, nextState.commitId, data!);
  }
  recordSyncMetric('pullRead', readAt - startedAt);
  recordSyncMetric('pullPrepare', preparedAt - readAt);
  recordSyncMetric('pullCommit', performance.now() - preparedAt);
  writes.forEach(row => recordSyncMetric('pullRecordWrite', 0, row.raw?.length ?? 0));
  return { applied: true, data: options.preserveLiveData ? undefined : data!, cursor: stage.cursor,
    changed: options.preserveLiveData ? 0 : writes.length, commitId: writes.length ? nextState.commitId : before.state.commitId };
}
