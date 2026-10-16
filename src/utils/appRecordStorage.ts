import type { AppData } from '../types';
import { normalizeAppData } from './appDataValidation';
import { recordSyncMetric } from './syncMetrics';
import type { PreparedQuestionImageCopy } from './questionImageRecords';
import { queueUserEditGeneration } from './userEditGeneration';
import { BLOB_STORES, queueRecordHistory, queueContentUpload, queueBlobReferences, packBlobNote, parseBlobNote, readMeta } from './blobVault';
import { queueLearningEvent } from './learningEvents';

export const APP_RECORD_STORES = ['appRecords', 'appRecordMeta', 'appOutbox', 'appRecordBackups', 'appPullStage', 'appRecordConflicts', 'categoryNotes', 'categoryNoteBackups', 'localProjections', 'questionImageBlobs', 'appPullMedia', ...BLOB_STORES, 'recordHistory', 'deltaStage'] as const;
export const APP_COLLECTIONS = ['folders', 'problemSets', 'questions', 'progress', 'answerLogs'] as const;
export type AppCollection = typeof APP_COLLECTIONS[number];
export const RECORD_COLLECTIONS = [...APP_COLLECTIONS, 'localStorage', 'indexedDbNotes', 'questionImages'] as const;
export type RecordCollection = typeof RECORD_COLLECTIONS[number];
export type AppRecord = {
  key: string;
  collection: RecordCollection;
  id: string;
  raw: string | null;
  /** Complete local value when raw is a chunk manifest. Never sent as an operation. */
  logicalRaw?: string;
  position: number;
  serverRevision: number;
  localRevision: number;
};
export type AppOutboxOperation = {
  transferReady?: 0 | 1;
  operationId: string;
  key: string;
  collection: RecordCollection;
  id: string;
  raw: string | null;
  position: number;
  baseRevision: number;
  localRevision: number;
  /** Exact acknowledged ancestor, retained while unsent changes coalesce. */
  baseContent?: { raw: string | null; position: number };
};
export type AppRecordState = {
  schema: 1;
  revision: number;
  commitId: string;
  savedAt: string;
  counts: Record<AppCollection, number>;
};
export type AppRecordSnapshot = { state: AppRecordState; records: Map<string, AppRecord> };
type Snapshot = AppRecordSnapshot;
const snapshots = new WeakMap<IDBDatabase, Snapshot>();
const materialized = new WeakMap<IDBDatabase, { commitId: string; data: AppData }>();
const LEGACY_STORE = 'appData';
const RECORD_AUTHORITY_KEY = 'quiz-make-app-data-v1:record-schema';

export function upgradeAppRecordStores(db: IDBDatabase, upgradeTransaction?: IDBTransaction): void {
  const created=new Set<string>();
  APP_RECORD_STORES.forEach(name => { if (!db.objectStoreNames.contains(name)) {
    created.add(name);
    const store = db.createObjectStore(name);
    if (name === 'questionImageBlobs') store.createIndex('questionId','questionId',{unique:false});
    if (name === 'appOutbox') store.createIndex('transferReady',['collection','transferReady']);
    if (name === 'appRecordConflicts') store.createIndex('kind','kind');
  } });
  if(upgradeTransaction&&!created.has('appOutbox')){const store=upgradeTransaction.objectStore('appOutbox');if(!store.indexNames.contains('transferReady'))store.createIndex('transferReady',['collection','transferReady']);}
  if(upgradeTransaction&&!created.has('appRecordConflicts')){const store=upgradeTransaction.objectStore('appRecordConflicts');if(!store.indexNames.contains('kind'))store.createIndex('kind','kind');}
  if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE);
  if (!db.objectStoreNames.contains('storageLedger')) db.createObjectStore('storageLedger');
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Record read failed.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Record transaction aborted.'));
  });
}

export function validateState(value: AppRecordState): void {
  if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.commitId !== 'string' || !value.commitId
    || !Number.isFinite(Date.parse(value.savedAt))
    || APP_COLLECTIONS.some(name => !Number.isSafeInteger(value.counts?.[name]) || value.counts[name] < 0)) {
    throw new Error('レコード保存状態が壊れています。復旧データを確認してください。');
  }
}

export function appRecordKey(collection: RecordCollection, id: string): string {
  return JSON.stringify([collection, id]);
}

export function materializeAppRecords(snapshot: Snapshot): AppData {
  const data: AppData = { version: 1, folders: [], problemSets: [], questions: [], progress: [], answerLogs: [] };
  for (const collection of APP_COLLECTIONS) {
    const rows = [...snapshot.records.values()].filter(row => row.collection === collection && row.raw !== null);
    rows.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    if (rows.length !== snapshot.state.counts[collection]) throw new Error('保存レコードの一部が失われています。');
    // Each collection's value is validated together below, including references.
    (data[collection] as unknown[]) = rows.map(row => {
      const value = JSON.parse(row.raw!);
      if ((collection === 'progress' ? value.questionId : value.id) !== row.id) throw new Error('保存レコードのIDが一致しません。');
      return value;
    });
  }
  const normalized = normalizeAppData(data);
  if (!normalized.ok) throw new Error(normalized.error);
  // Progress is derived for questions without a stored row, including a
  // deliberate tombstone. All stored progress must still reference a question.
  const questionIds = new Set(data.questions.map(question => question.id));
  if (data.progress.some(row => !questionIds.has(row.questionId))
    || APP_COLLECTIONS.some(name => name !== 'progress' && normalized.data[name].length !== data[name].length)) {
    throw new Error('保存レコードの参照が壊れています。');
  }
  return normalized.data;
}

export async function readAppRecordSnapshot(db: IDBDatabase): Promise<Snapshot | null> {
  const tx = db.transaction(['appRecordMeta', 'appRecords', LEGACY_STORE], 'readonly');
  const done = transactionDone(tx);
  const stateRequest = requestResult<AppRecordState | undefined>(tx.objectStore('appRecordMeta').get('state'));
  const rowsRequest = requestResult<AppRecord[]>(tx.objectStore('appRecords').getAll());
  const authorityRequest = requestResult(tx.objectStore(LEGACY_STORE).get(RECORD_AUTHORITY_KEY));
  const [state, rows, authority] = await Promise.all([stateRequest, rowsRequest, authorityRequest, done]);
  if (!state) {
    snapshots.delete(db);
    if (rows.length || authority !== undefined) throw new Error('移行状態のない保存レコードが見つかりました。');
    return null;
  }
  validateState(state);
  const records = new Map<string, AppRecord>();
  for (const row of rows) {
    if (!RECORD_COLLECTIONS.includes(row.collection) || typeof row.id !== 'string' || !row.id
      || row.key !== appRecordKey(row.collection, row.id) || records.has(row.key)
      || !(row.raw === null || typeof row.raw === 'string')
      || !Number.isSafeInteger(row.position) || row.position < 0
      || !Number.isSafeInteger(row.serverRevision) || row.serverRevision < 0
      || !Number.isSafeInteger(row.localRevision) || row.localRevision > state.revision) {
      throw new Error('保存レコードの形式が不正です。');
    }
    records.set(row.key, row);
  }
  return { state, records };
}

/** Reuse a snapshot only against a commit ID read from IndexedDB. The Pull
 * transaction checks that ID again before writing, so another tab cannot
 * apply changes on top of a stale in-memory view. */
export async function readAppRecordSnapshotForCommit(db: IDBDatabase, commitId: string): Promise<Snapshot | null> {
  const cached = snapshots.get(db);
  if (cached?.state.commitId === commitId) {
    recordSyncMetric('recordSnapshotReused');
    return cached;
  }
  const snapshot = await readAppRecordSnapshot(db);
  if (snapshot) snapshots.set(db, snapshot);
  return snapshot;
}

/** Probe the durable commit before reusing any in-memory records. */
export async function readCurrentAppRecordSnapshot(db: IDBDatabase): Promise<Snapshot | null> {
  const tx = db.transaction('appRecordMeta', 'readonly'), done = transactionDone(tx);
  const request = tx.objectStore('appRecordMeta').get('state');
  await done;
  return request.result ? readAppRecordSnapshotForCommit(db, request.result.commitId) : readAppRecordSnapshot(db);
}

export function rememberAppRecordChanges(db: IDBDatabase, previousCommitId: string, state: AppRecordState, changes: readonly AppRecord[], studyChanges = true): void {
  const prior = snapshots.get(db), cached = materialized.get(db);
  if (prior?.state.commitId === previousCommitId) {
    const records = new Map(prior.records);
    changes.forEach(row => records.set(row.key, row));
    snapshots.set(db, { state, records });
  } else snapshots.delete(db);
  if (cached?.commitId === previousCommitId && !studyChanges) rememberAppRecordData(db, state.commitId, cached.data);
  else if (cached?.commitId === previousCommitId && changes.every(row => row.raw && (row.collection === 'progress' || row.collection === 'answerLogs'))) {
    const progress = new Map(changes.filter(row => row.collection === 'progress').map(row => [row.id, JSON.parse(row.raw!)]));
    const logs = changes.filter(row => row.collection === 'answerLogs').map(row => JSON.parse(row.raw!));
    rememberAppRecordData(db, state.commitId, { ...cached.data,
      progress: cached.data.progress.map(row => progress.get(row.questionId) ?? row), answerLogs: [...cached.data.answerLogs, ...logs] });
  } else materialized.delete(db);
}

/** Called only after a Pull transaction has committed its state and rows. */
export function rememberAppRecordSnapshot(db: IDBDatabase, snapshot: Snapshot): void {
  snapshots.set(db, snapshot);
}

export function readCachedAppRecordData(db: IDBDatabase, commitId: string): AppData | null {
  const cached = materialized.get(db);
  return cached?.commitId === commitId ? cached.data : null;
}

/** The caller supplies canonical data only after the matching IDB commit. */
export function rememberAppRecordData(db: IDBDatabase, commitId: string, data: AppData): void {
  materialized.set(db, { commitId, data });
}

export async function readAppRecords(db: IDBDatabase): Promise<{ data: AppData; savedAt: string } | null> {
  try {
    const snapshot = await readAppRecordSnapshot(db);
    if (!snapshot) return null;
    const data = materializeAppRecords(snapshot);
    snapshots.set(db, snapshot);
    rememberAppRecordData(db, snapshot.state.commitId, data);
    return { data, savedAt: snapshot.state.savedAt };
  } catch (error) {
    snapshots.delete(db);
    throw error;
  }
}

/** Reconstruct the last complete commit, never a mixture guessed by timestamps. */
export async function readPreviousAppRecords(db: IDBDatabase): Promise<{ data: AppData; savedAt: string } | null> {
  const tx = db.transaction(['appRecordMeta', 'appRecords', 'appRecordBackups'], 'readonly');
  const done = transactionDone(tx);
  const [state, current, backups, fallback] = await Promise.all([
    requestResult<AppRecordState | undefined>(tx.objectStore('appRecordMeta').get('previousState')),
    requestResult<AppRecord[]>(tx.objectStore('appRecords').getAll()),
    requestResult<Array<AppRecord & { replacedAt: number }>>(tx.objectStore('appRecordBackups').getAll()),
    requestResult<{ raw: string; savedAt: string } | undefined>(tx.objectStore('appRecordMeta').get('migrationFallback')), done,
  ]);
  if (!state) {
    if (!fallback) return null;
    const normalized = normalizeAppData(JSON.parse(fallback.raw));
    if (!normalized.ok) throw new Error(normalized.error);
    return { data: normalized.data, savedAt: fallback.savedAt };
  }
  validateState(state);
  const records = new Map(current.filter(row => row.localRevision <= state.revision).map(row => [row.key, row]));
  // Only the versions replaced by the last commit belong to this undo image.
  backups.filter(row => row.replacedAt === state.revision + 1).forEach(row => records.set(row.key, row));
  return { data: materializeAppRecords({ state, records }), savedAt: state.savedAt };
}

/** Current data, deletion tombstones, previous records, revision and outbox commit together. */
export async function saveAppRecords(
  db: IDBDatabase, data: AppData, savedAt: string,
  migrationFallback?: () => { raw: string | null; savedAt: string | null },
  imageCopies: readonly PreparedQuestionImageCopy[] = [],
  extraCommit?: (transaction: IDBTransaction) => void,
  userEdit = true,
  materialRecords: Record<string,string> = {},
): Promise<void> {
  const started = performance.now();
  if (Object.keys(materialRecords).length && await readMeta(db, 'deltaEnabled')) {
    const packed: Record<string,string> = {};
    for (const [key, raw] of Object.entries(materialRecords)) packed[key] = await packBlobNote(db, raw);
    materialRecords = packed;
  }
  const readTx = db.transaction('appRecordMeta', 'readonly');
  const readDone = transactionDone(readTx);
  const [state] = await Promise.all([requestResult<AppRecordState | undefined>(readTx.objectStore('appRecordMeta').get('state')), readDone]);
  let previous = snapshots.get(db);
  if (!previous || !state || previous.state.commitId !== state.commitId) {
    previous = await readAppRecordSnapshot(db) ?? undefined;
    if (previous) materializeAppRecords(previous);
  }
  const revision = (previous?.state.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('保存Revisionの上限に達しました。');
  const rows = new Map(previous?.records);
  const liveKeys = new Set<string>();
  const changes: AppRecord[] = [];
  const counts = {} as Record<AppCollection, number>;
  for (const collection of APP_COLLECTIONS) {
    counts[collection] = data[collection].length;
    data[collection].forEach((value, position) => {
      const id = 'questionId' in value && collection === 'progress' ? value.questionId : (value as { id: string }).id;
      const key = appRecordKey(collection, id);
      if (liveKeys.has(key)) throw new Error('重複する保存レコードIDです。');
      liveKeys.add(key);
      const raw = JSON.stringify(value);
      const old = rows.get(key);
      if (old?.raw === raw && old.position === position) return;
      changes.push({ key, collection, id, raw, position, serverRevision: old?.serverRevision ?? 0, localRevision: revision });
    });
  }
  previous?.records.forEach(old => {
    if (APP_COLLECTIONS.some(name => name === old.collection) && old.raw !== null && !liveKeys.has(old.key)) changes.push({ ...old, raw: null, localRevision: revision });
  });
  for(const {image,descriptor,source} of imageCopies){
    const original=previous?.records.get(appRecordKey('questionImages',source.id));
    const originalDescriptor=original?.raw?JSON.parse(original.raw):null;
    const key=appRecordKey('questionImages',image.id);
    const target=data.questions.find(question=>question.id===image.questionId);
    if(!originalDescriptor || originalDescriptor.questionId!==source.questionId || originalDescriptor.sha256!==source.sha256
      || rows.has(key) || liveKeys.has(key) || image.id!==descriptor.id || image.questionId!==descriptor.questionId
      || image.blob.size!==descriptor.size || image.blob.type!==descriptor.type || descriptor.sha256!==source.sha256
      || !target || ![...(target.questionImageIds??[]),...(target.detailedAnswer?.imageIds??[])].includes(image.id)) {
      throw new Error('コピー元の画像または保存先が変更されています。問題を確認してから再試行してください。');
    }
    liveKeys.add(key);
    changes.push({key,collection:'questionImages',id:image.id,raw:JSON.stringify(descriptor),position:0,serverRevision:0,localRevision:revision});
  }
  for(const [id,raw] of Object.entries(materialRecords)){
    const key=appRecordKey('indexedDbNotes',id);
    // Import only creates fresh material identities. Never overwrite local ink.
    if(rows.has(key))throw new Error('取り込み先の資料がすでに存在します。もう一度取り込んでください。');
    changes.push({key,collection:'indexedDbNotes',id,raw,position:0,serverRevision:0,localRevision:revision});
  }
  if (previous && changes.length === 0 && !extraCommit) { recordSyncMetric('recordSaveUnchanged'); return; }
  const nextState: AppRecordState = { schema: 1, revision, commitId: crypto.randomUUID(), savedAt, counts };
  const fallback = !previous ? migrationFallback?.() : undefined;
  const operations = changes.map(row => ({
    operationId: crypto.randomUUID(), key: row.key, collection: row.collection, id: row.id,
    raw: row.raw, position: row.position, baseRevision: row.serverRevision, localRevision: revision,
    ...(row.collection === 'indexedDbNotes' ? { transferReady: 1 as const } : {}),
  } satisfies AppOutboxOperation));
  const tx = db.transaction([...APP_RECORD_STORES, LEGACY_STORE, ...(extraCommit ? ['appDataBackups'] : [])], 'readwrite');
  const done = transactionDone(tx);
  const check = tx.objectStore('appRecordMeta').get('state');
  let conflict = false;
  let writeFailure: unknown;
  check.onsuccess = () => {
    try {
    if (check.result?.commitId !== previous?.state.commitId) { conflict = true; tx.abort(); return; }
    for(const [id,raw] of Object.entries(materialRecords)){
      const existing=tx.objectStore('categoryNotes').get(id);
      existing.onsuccess=()=>{if(existing.result!==undefined){conflict=true;tx.abort();return;}tx.objectStore('categoryNotes').put(raw,id);};
      if(/"kind"\s*:\s*"quiz-material-file"/u.test(raw))tx.objectStore('appRecordMeta').put(1,'recordMediaPresent');
      queueBlobReferences(tx, `current:${appRecordKey('indexedDbNotes',id)}`, raw);
      queueBlobReferences(tx, `pending:${appRecordKey('indexedDbNotes',id)}`, raw);
      for (const ref of parseBlobNote(raw)?.blobs ?? []) queueContentUpload(tx, ref);
    }
    for(const {image,descriptor,source} of imageCopies){
      const sourceBlob=tx.objectStore('questionImageBlobs').get(source.id);
      sourceBlob.onsuccess=()=>{
        try {
          const original=sourceBlob.result;
          if(!original || original.questionId!==source.questionId || (original.blob?.size??original.vaultRef?.size)!==descriptor.size || (original.blob?.type??original.vaultRef?.type)!==descriptor.type){conflict=true;tx.abort();return;}
          if (descriptor.vault) {
            const { blob: _blob, ...metadata } = image;
            tx.objectStore('questionImageBlobs').put({ ...metadata, vaultRef: descriptor }, image.id);
            queueContentUpload(tx, descriptor); queueBlobReferences(tx, `image:${image.id}`, JSON.stringify(descriptor));
          } else tx.objectStore('questionImageBlobs').put(image,image.id);
        } catch(error) { writeFailure=error;tx.abort(); }
      };
    }
    const finish=()=>{
      tx.objectStore('appRecordMeta').put(nextState, 'state');
      if (!previous) tx.objectStore(LEGACY_STORE).put(1, RECORD_AUTHORITY_KEY);
      if (previous) tx.objectStore('appRecordMeta').put(previous.state, 'previousState');
      if (fallback?.raw) tx.objectStore('appRecordMeta').put(fallback, 'migrationFallback');
      if(changes.length&&userEdit)queueUserEditGeneration(tx);
      if (userEdit) for (const row of changes) if (row.collection === 'progress' && row.raw) {
        const old = previous?.records.get(row.key);
        const answers = changes.filter(change => change.collection === 'answerLogs' && change.raw && !previous?.records.get(change.key)?.raw)
          .map(change => JSON.parse(change.raw!)).filter(answer => answer.questionId === row.id);
        for (const answer of answers.length ? answers : [undefined]) {
          const event = queueLearningEvent(tx, revision, old?.raw ? JSON.parse(old.raw) : undefined, JSON.parse(row.raw), answer);
          if (event) rows.set(event.key, event);
        }
      }
      extraCommit?.(tx);
    };
    let next=0;
    const pump=()=>{
      const end=Math.min(next+128,changes.length);let remaining=end-next;
      if(!remaining){finish();return;}
      for(;next<end;next++){
      const index=next,row=changes[index];
      const old = previous?.records.get(row.key);
      if (old) tx.objectStore('appRecordBackups').put({ ...old, replacedAt: revision }, row.key);
      queueRecordHistory(tx, row.key, old, row.raw);
      tx.objectStore('appRecords').put(row, row.key);
      // Coalesce unsent changes. A transport must durably freeze a batch before
      // sending and only acknowledge the exact operationId it sent.
      const pending = tx.objectStore('appOutbox').get(row.key);
      pending.onsuccess = () => {
        try {
          const prior = pending.result as AppOutboxOperation | undefined;
          const baseContent = prior
            ? (prior.baseRevision === row.serverRevision ? prior.baseContent : undefined)
            : old && old.serverRevision > 0 ? { raw: old.raw, position: old.position } : undefined;
          tx.objectStore('appOutbox').put({ ...operations[index], ...(baseContent ? { baseContent } : {}) }, row.key);
          if(--remaining===0)pump();
        } catch (error) { writeFailure = error; tx.abort(); }
      };
      rows.set(row.key, row);
      }
    };
    // IDB callbacks keep one atomic transaction alive without retaining a
    // pending request and cloned body for every question at once.
    pump();
    } catch (error) { writeFailure = error; tx.abort(); }
  };
  try { await done; } catch (error) {
    snapshots.delete(db);
    if (conflict) throw new Error('別のタブで保存レコードが変更されました。再読み込みしてください。');
    throw writeFailure ?? error;
  }
  if(extraCommit){snapshots.delete(db);materialized.delete(db);}
  else {snapshots.set(db, { state: nextState, records: rows });rememberAppRecordData(db, nextState.commitId, data);}
  recordSyncMetric('recordCommit', performance.now() - started);
  changes.forEach(row => recordSyncMetric('recordWrite', 0, row.raw?.length ?? 0));
}

export async function readAppOutbox(db: IDBDatabase): Promise<AppOutboxOperation[]> {
  const tx = db.transaction('appOutbox', 'readonly');
  const done = transactionDone(tx);
  const [operations] = await Promise.all([requestResult<AppOutboxOperation[]>(tx.objectStore('appOutbox').getAll()), done]);
  return operations;
}
