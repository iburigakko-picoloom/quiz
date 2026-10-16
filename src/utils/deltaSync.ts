import { APP_COLLECTIONS, appRecordKey, materializeAppRecords, readCurrentAppRecordSnapshot, rememberAppRecordSnapshot, rememberAppRecordData, type AppOutboxOperation, type AppRecord, type AppRecordState } from './appRecordStorage';
import { bindRecordSyncConnection, sameRecordSyncConnection, type RecordSyncConnection } from './recordSyncOutbox';
import type { RecordSyncGuards, RecordSyncOutcome } from './recordSyncEngine';
import type { RemoteRecordChange, RecordPullApplyOptions } from './recordSyncPull';
import { sameRecordContent } from './recordSyncPull';
import { idbDone, idbResult, readMeta, writeMeta, blobHash, parseBlobNote, queueBlobReferences, queueRecordHistory } from './blobVault';
import { categoryNoteRecoveryKeys } from './noteStorage';
import { getSyncDevice } from './syncDevice';
import { isChunkInternal, parseChunkManifest, restoreRecordChunks } from './recordChunkFormat';

type Reply = { code: string; [key: string]: unknown };
export type DeltaTransport = { delta(action: string, body?: Record<string, unknown>): Promise<Reply> };
type Frozen = { connection: RecordSyncConnection; operationId: string; deviceId: string; sequence: number; digest: string; parts: string[]; operations: AppOutboxOperation[] };
type Cursor = { connection: RecordSyncConnection; revision: number };
const assertReply = (r: Reply) => { if (r.code !== 'ok') throw new Error(`同期を一時停止しています（${r.code}）。端末の学習データと未送信データは保持しています。`); };
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Freeze one atomic set of dependent edits. It is never regenerated after a
 * network failure. Local edits made during upload receive different operation IDs. */
export async function freezeDelta(db: IDBDatabase, connection: RecordSyncConnection, deviceId: string): Promise<Frozen | undefined> {
  await bindRecordSyncConnection(db, connection);
  const saved = await readMeta<Frozen>(db, 'deltaFrozen');
  if (saved) { if (!sameRecordSyncConnection(saved.connection, connection)) throw new Error('別のアカウントの未確認送信があります。'); return saved; }
  const tx = db.transaction(['appOutbox', 'appRecordMeta'], 'readonly'), done = idbDone(tx);
  const store=tx.objectStore('appOutbox'), ready=store.index('transferReady').getAllKeys(['indexedDbNotes',1]),keys=store.getAllKeys(),pending:AppOutboxOperation[]=[];
  keys.onsuccess=()=>{const noteKeys=new Set(ready.result.map(String));for(const key of keys.result){if(JSON.parse(String(key))[0]==='indexedDbNotes'&&!noteKeys.has(String(key)))continue;const request=store.get(key);request.onsuccess=()=>{if(request.result)pending.push(request.result);};}};
  const seq = tx.objectStore('appRecordMeta').get('deltaSequence'), state = tx.objectStore('appRecordMeta').get('state');
  await done;
  const blocked = new Set(categoryNoteRecoveryKeys());
  const readyKeys = new Set(ready.result.map(String));
  for (const key of keys.result) { const [collection,id] = JSON.parse(String(key)); if (collection === 'indexedDbNotes' && !readyKeys.has(String(key))) blocked.add(id); }
  const blockedImages = new Set<string>();
  const operations = pending.filter(op => {
    if (op.collection === 'indexedDbNotes' && (blocked.has(op.id) || (op.raw?.includes('data:') && !parseBlobNote(op.raw)))) { blocked.add(op.id); return false; }
    if (op.collection === 'questionImages' && op.raw && !JSON.parse(op.raw).path && !JSON.parse(op.raw).vault) { blockedImages.add(op.id); return false; }
    return true;
  });
  if (!operations.length) return undefined;
  // A question's material dependencies must be kept together; quarantine only
  // that question's edits, leaving unrelated answers and progress sendable.
  const blockedSets = new Set([...blocked].map(key => key.split(':')[2]));
  const heldNewQuestions = new Set<string>();
  let selected = operations.filter(op => {
    if (op.collection !== 'questions' || !op.raw) return true;
    const q = JSON.parse(op.raw);
    const held = (blockedSets.has(q.setId) && q.materialReferences?.length) || [...(q.questionImageIds??[]),...(q.detailedAnswer?.imageIds??[])].some(id=>blockedImages.has(id));
    if (held && op.baseRevision === 0) heldNewQuestions.add(op.id);
    return !held;
  });
  selected = selected.filter(op => !op.raw || !( ['progress','answerLogs','questionImages'].includes(op.collection) || (op.collection==='localStorage' && op.id.startsWith('quizMake:sync-event:')) ) || !heldNewQuestions.has(JSON.parse(op.raw).questionId));
  if (!selected.length) return undefined;
  // Older/fallback saves have answer rows but no intent record. Turn each new
  // immutable answer ID into an event in this same frozen operation. Replayed
  // existing answer IDs are ignored by the server.
  const eventAnswers = new Set(selected.filter(op=>op.collection==='localStorage'&&op.id.startsWith('quizMake:sync-event:')&&op.raw).map(op=>JSON.parse(op.raw!).answer?.id));
  const answerQuestions = new Set<string>();
  for (const answer of [...selected]) if (answer.collection==='answerLogs'&&answer.raw) {
    const value=JSON.parse(answer.raw);answerQuestions.add(value.questionId);
    if (eventAnswers.has(value.id)) continue;
    const id='quizMake:sync-event:'+crypto.randomUUID();
    selected.push({operationId:crypto.randomUUID(),key:appRecordKey('localStorage',id),collection:'localStorage',id,raw:JSON.stringify({kind:'quiz-learning-event',version:1,questionId:value.questionId,action:'answer',answer:value}),position:0,localRevision:answer.localRevision,baseRevision:0});
  }
  for (let i=selected.length-1;i>=0;i--) if(selected[i].id.startsWith('quizMake:sync-event:')&&selected[i].raw){const event=JSON.parse(selected[i].raw!);if(event.action==='initialize'&&answerQuestions.has(event.questionId))selected.splice(i,1);}
  const payload = JSON.stringify(selected.map(({ baseContent: _base, ...op }) => op));
  const parts: string[] = []; let start = 0;
  while (start < payload.length) {
    let end = Math.min(start + 24000, payload.length);
    if (end < payload.length && /[\uD800-\uDBFF]/.test(payload[end - 1])) end--;
    parts.push(payload.slice(start, end)); start = end;
  }
  const frozen: Frozen = { connection, operationId: crypto.randomUUID(), deviceId, sequence: (seq.result ?? 0) + 1,
    digest: await blobHash(new Blob([payload])), parts, operations: selected };
  const write = db.transaction(['appRecordMeta','contentBlobRefs'], 'readwrite'), complete = idbDone(write);
  const current = write.objectStore('appRecordMeta').get('state'), old = write.objectStore('appRecordMeta').get('deltaFrozen');
  old.onsuccess = () => {
    if (current.result?.commitId !== state.result?.commitId || old.result) { write.abort(); return; }
    write.objectStore('appRecordMeta').put(frozen, 'deltaFrozen'); write.objectStore('appRecordMeta').put(frozen.sequence, 'deltaSequence');
    for(const operation of frozen.operations)queueBlobReferences(write,`frozen:${frozen.operationId}:${operation.key}`,operation.raw);
  };
  await complete; return frozen;
}
async function acknowledgeDelta(db: IDBDatabase, frozen: Frozen, revision: number): Promise<void> {
  if (!validRevision(revision) || revision < 1) throw new Error('送信結果の確定順を確認できません。');
  const tx = db.transaction(['appRecordMeta', 'appOutbox','contentBlobRefs'], 'readwrite'), done = idbDone(tx);
  const existing = tx.objectStore('appRecordMeta').get('deltaFrozen');
  existing.onsuccess = () => {
    if (existing.result?.operationId !== frozen.operationId || existing.result?.digest !== frozen.digest) { tx.abort(); return; }
    for (const op of frozen.operations) {
      const current = tx.objectStore('appOutbox').get(op.key);
      current.onsuccess = () => { if (current.result?.operationId === op.operationId) {tx.objectStore('appOutbox').delete(op.key);tx.objectStore('contentBlobRefs').delete(`pending:${op.key}`);} };
      tx.objectStore('contentBlobRefs').delete(`frozen:${frozen.operationId}:${op.key}`);
    }
    tx.objectStore('appRecordMeta').delete('deltaFrozen');
  };
  await done;
}
export async function sendDelta(db: IDBDatabase, transport: DeltaTransport, frozen: Frozen, assertCurrent: () => Promise<void>): Promise<number> {
  await assertCurrent(); const receipt = await transport.delta('receipt', { operationId: frozen.operationId }); assertReply(receipt);
  if (receipt.state === 'committed') { await assertCurrent(); await acknowledgeDelta(db, frozen, Number(receipt.revision)); return frozen.operations.length; }
  for (let index = 0; index < frozen.parts.length; index++) {
    await assertCurrent();
    const reply = await transport.delta('push', { operationId: frozen.operationId, deviceId: frozen.deviceId, sequence: frozen.sequence,
      digest: frozen.digest, parts: frozen.parts.length, part: index, payload: frozen.parts[index] });
    assertReply(reply);
    if (reply.state === 'committed') { await assertCurrent(); await acknowledgeDelta(db, frozen, Number(reply.revision)); return frozen.operations.length; }
  }
  throw new Error('送信結果がまだ確定していません。同じ操作IDで確認を続けます。');
}
/** One complete operation (or verified checkpoint) is committed atomically.
 * A newer unsent local edit stays pending and is sent in the next operation. */
export async function applyDeltaRows(db: IDBDatabase, connection: RecordSyncConnection, rows: RemoteRecordChange[], revision: number, options: RecordPullApplyOptions = {}, checkpoint = false) {
  const before = await readCurrentAppRecordSnapshot(db); if (!before) throw new Error('端末の保存状態を確認できません。');
  if (options.preserveLiveData && rows.length) return { applied: false as const, deferred: true as const, commitId: before.state.commitId };
  const read = db.transaction('appOutbox', 'readonly'), readDone = idbDone(read);
  const pending = new Map((await idbResult<AppOutboxOperation[]>(read.objectStore('appOutbox').getAll())).map(op => [op.key, op])); await readDone;
  const released: AppOutboxOperation[] = [], candidates: Array<{ local: AppOutboxOperation; remote: RemoteRecordChange }> = [];
  if (checkpoint) for (const remote of rows) {
    const op = pending.get(remote.key);
    if (!op || op.baseRevision > 0) continue;
    // A bootstrap queue is not proof of an edit after the last cloud version.
    // Keep differing legacy originals for explicit recovery, never retimestamp
    // and upload them merely because the new application opened the database.
    if (!sameRecordContent(op.collection, op.raw, remote.raw)) candidates.push({ local: op, remote });
    released.push(op); pending.delete(remote.key);
  }
  const next = new Map(before.records), writes: AppRecord[] = [];
  const counts = { ...before.state.counts };
  for (const remote of new Map(rows.map(row => [row.key, row])).values()) {
    if (remote.key !== appRecordKey(remote.collection, remote.id) || !validRevision(remote.revision)
      || !(remote.raw === null || typeof remote.raw === 'string') || !Number.isSafeInteger(remote.position)) throw new Error('差分データの形式を確認できません。');
    if (pending.has(remote.key)) continue;
    const old = next.get(remote.key);
    if (old && old.serverRevision > remote.revision) continue;
    const row: AppRecord = { ...remote, serverRevision: remote.revision, localRevision: before.state.revision + 1 };
    if (old?.raw === row.raw && old.position === row.position && old.serverRevision === row.serverRevision) continue;
    if ((APP_COLLECTIONS as readonly string[]).includes(row.collection)) counts[row.collection as keyof typeof counts] += Number(row.raw !== null) - Number(old?.raw != null);
    next.set(row.key, row); writes.push(row);
  }
  // A remote parent deletion also closes a concurrently edited child. Archive
  // that exact unsent child before releasing it; never leave an orphan that
  // prevents unrelated learning records from being applied.
  let cascade = true;
  while(cascade){cascade=false;for(const old of next.values()){
    if(!old.raw||!['folders','problemSets','questions','progress','answerLogs','questionImages'].includes(old.collection))continue;
    const value=JSON.parse(old.logicalRaw??old.raw);
    const parent=old.collection==='problemSets'?appRecordKey('folders',value.folderId):old.collection==='questions'?appRecordKey('problemSets',value.setId)
      :['progress','answerLogs','questionImages'].includes(old.collection)?appRecordKey('questions',value.questionId)
      :old.collection==='folders'&&value.parentId?appRecordKey('folders',value.parentId):null;
    if(!parent||next.get(parent)?.raw!==null)continue;
    const remote:RemoteRecordChange={key:old.key,collection:old.collection,id:old.id,raw:null,position:old.position,revision};
    const local=pending.get(old.key);
    if(local){candidates.push({local,remote});released.push(local);pending.delete(old.key);}
    const row:AppRecord={...old,raw:null,serverRevision:revision,localRevision:before.state.revision+1};delete row.logicalRaw;
    next.set(row.key,row);writes.push(row);cascade=true;
    if((APP_COLLECTIONS as readonly string[]).includes(row.collection))counts[row.collection as keyof typeof counts]--;
  }}
  // Read legacy multipart notes from their exact existing chunks on first upgrade.
  for (const row of writes) {
    const manifest = parseChunkManifest(row.raw, row.collection, row.id);
    if (manifest) row.logicalRaw = await restoreRecordChunks(manifest, new Map([...next.values()].filter(r => r.collection === 'localStorage' && r.raw !== null).map(r => [r.id, r.raw!])));
  }
  const state: AppRecordState = { ...before.state, revision: before.state.revision + 1, counts, commitId: crypto.randomUUID(), savedAt: new Date().toISOString() };
  const data = materializeAppRecords({ state, records: next });
  // Save in the same canonical representation as local edits. PostgreSQL JSONB
  // key order differs from the browser's normalized objects; treating that as
  // a concurrent edit would prevent the first answer after an upgrade.
  const canonical=new Map<string,string>();
  for(const collection of APP_COLLECTIONS)for(const value of data[collection])canonical.set(appRecordKey(collection,collection==='progress'?(value as {questionId:string}).questionId:(value as {id:string}).id),JSON.stringify(value));
  for(const row of writes)if(row.raw!==null&&canonical.has(row.key))row.raw=canonical.get(row.key)!;
  const tx = db.transaction(['appRecords', 'appRecordMeta', 'appOutbox', 'appRecordBackups', 'appRecordConflicts', 'recordHistory', 'categoryNotes', 'localProjections', 'contentBlobRefs',...['appDataBackups'].filter(name=>db.objectStoreNames.contains(name))], 'readwrite'), done = idbDone(tx);
  const current = tx.objectStore('appRecordMeta').get('state');
  current.onsuccess = () => {
    if (current.result?.commitId !== before.state.commitId) { tx.abort(); return; }
    for (const op of released) {
      const queued = tx.objectStore('appOutbox').get(op.key);
      queued.onsuccess = () => { if (queued.result?.operationId === op.operationId) tx.objectStore('appOutbox').delete(op.key); else tx.abort(); };
    }
    for (const candidate of candidates) {
      tx.objectStore('appRecordConflicts').put({ kind: 'legacy-recovery-candidate', connection, ...candidate, archivedAt: new Date().toISOString(),
        conflict: { connection, key:candidate.local.key, operationId:candidate.local.operationId, local:{...candidate.local,serverRevision:candidate.local.baseRevision},remote:candidate.remote } }, `legacy:${candidate.local.operationId}`);
      queueBlobReferences(tx, `legacy-candidate:${candidate.local.operationId}`, candidate.local.raw);
    }
    for (const row of writes) {
      const old = before.records.get(row.key);
      if (old && old.raw !== row.raw) {
        tx.objectStore('appRecordBackups').put({ ...old, replacedAt: state.revision }, row.key);
        queueRecordHistory(tx,row.key,old,row.raw);
      }
      tx.objectStore('appRecords').put(row, row.key);
      if (row.collection === 'indexedDbNotes') {
        const projection=tx.objectStore('categoryNotes').get(row.id);
        projection.onsuccess=()=>{
          if(typeof projection.result==='string'&&projection.result!==(old?.logicalRaw??old?.raw)&&projection.result!==(row.logicalRaw??row.raw)&&tx.objectStoreNames.contains('appDataBackups')) {
            const id=`delta-note-original:${row.id}:${crypto.randomUUID()}`;
            tx.objectStore('appDataBackups').add(projection.result,id);queueBlobReferences(tx,`checkpoint:${id}`,projection.result);
            tx.objectStore('appRecordMeta').delete('archiveBlobMigration');
          }
          if (row.raw === null) tx.objectStore('categoryNotes').delete(row.id); else tx.objectStore('categoryNotes').put(row.logicalRaw ?? row.raw, row.id);
        };
        queueBlobReferences(tx, `current:${row.key}`, row.raw, false);
      }
      if (row.collection === 'localStorage' && !isChunkInternal(row.collection, row.id) && !row.id.startsWith('quizMake:sync-event:') && !row.id.startsWith('quizMake:answer-applied:')) tx.objectStore('localProjections').put(row.logicalRaw ?? row.raw, row.id);
    }
    tx.objectStore('appRecordMeta').put(state, 'state');
    tx.objectStore('appRecordMeta').put({ connection, revision } satisfies Cursor, 'deltaCursor');
    tx.objectStore('appRecordMeta').delete('deltaPull');
  };
  await done; rememberAppRecordSnapshot(db, { state, records: next }); rememberAppRecordData(db, state.commitId, data);
  return { applied: true as const, data, cursor: revision, changed: writes.length, commitId: state.commitId };
}
export async function runDeltaSync(db: IDBDatabase, connection: RecordSyncConnection, transport: DeltaTransport, guards: RecordSyncGuards, bootstrapOnly = false): Promise<RecordSyncOutcome> {
  await bindRecordSyncConnection(db, connection); await guards.assertCurrent();
  let uploaded = 0, downloaded = 0;
  const deviceId = JSON.parse(getSyncDevice()).id as string;
  let cursor = await readMeta<Cursor>(db, 'deltaCursor');
  if (cursor && !bootstrapOnly) {
    const frozen = await freezeDelta(db, connection, deviceId);
    if (frozen) uploaded += await sendDelta(db, transport, frozen, guards.assertCurrent);
  }
  if (cursor && !sameRecordSyncConnection(cursor.connection, connection)) throw new Error('受信履歴のアカウントが一致しません。');
  if (!cursor) {
    // Restartable initial checkpoint; never replace unsent rows or delete originals.
    let checkpoint = await readMeta<{ connection: RecordSyncConnection; revision?: number; after: string; offset: number; fragment: string }>(db, 'deltaCheckpoint');
    checkpoint ??= { connection, after: '', offset: 0, fragment: '' };
    if (!sameRecordSyncConnection(checkpoint.connection, connection)) throw new Error('引き継ぎ中のアカウントが一致しません。');
    for (let page = 0; page < 20; page++) {
      await guards.assertCurrent(); const reply = await transport.delta('checkpoint', { revision: checkpoint.revision, after: checkpoint.after, offset: checkpoint.offset });
      if (reply.code === 'conflict') {
        const tx = db.transaction(['deltaStage', 'appRecordMeta'], 'readwrite'), done = idbDone(tx); tx.objectStore('deltaStage').clear(); tx.objectStore('appRecordMeta').delete('deltaCheckpoint'); await done;
        return { status: 'more', uploaded, downloaded };
      }
      assertReply(reply); if (!Array.isArray(reply.rows) || !validRevision(reply.revision)) throw new Error('引き継ぎデータを確認できません。');
      const tx = db.transaction(['deltaStage', 'appRecordMeta'], 'readwrite'), done = idbDone(tx);
      for (const row of reply.rows as Array<{ key: string; fragment: string; complete: boolean }>) {
        checkpoint.fragment += row.fragment;
        if (row.complete) { const value = JSON.parse(checkpoint.fragment) as RemoteRecordChange; if (value.key !== row.key) { tx.abort(); throw new Error('引き継ぎの区切りが一致しません。'); } tx.objectStore('deltaStage').put(value, row.key); checkpoint.fragment = ''; }
      }
      checkpoint = { ...checkpoint, revision: reply.revision, after: String(reply.after), offset: Number(reply.offset) };
      tx.objectStore('appRecordMeta').put(checkpoint, 'deltaCheckpoint'); await done;
      if (reply.complete) {
        const read = db.transaction('deltaStage', 'readonly'), finished = idbDone(read); const rows = await idbResult<RemoteRecordChange[]>(read.objectStore('deltaStage').getAll()); await finished;
        const applied = await guards.apply(options => applyDeltaRows(db, connection, rows, reply.revision as number, options, true));
        if (!applied?.applied) return { status: 'deferred', uploaded, downloaded };
        downloaded += rows.length;
        const cleanup = db.transaction(['deltaStage','appRecordMeta'],'readwrite'), cleaned = idbDone(cleanup);
        cleanup.objectStore('deltaStage').clear(); cleanup.objectStore('appRecordMeta').delete('deltaCheckpoint'); await cleaned;
        cursor = { connection, revision: reply.revision }; break;
      }
    }
    if (!cursor) return { status: 'more', uploaded, downloaded };
  }
  if (bootstrapOnly) return { status: 'done', uploaded, downloaded };
  let stage = await readMeta<{ revision: number; offset: number; fragment: string }>(db, 'deltaPull');
  for (let page = 0; page < 20; page++) {
    await guards.assertCurrent(); const reply = await transport.delta('pull', { revision: stage?.revision ?? cursor.revision, offset: stage?.offset ?? 0 });
    if (reply.code === 'checkpoint_required') { await writeMeta(db, 'deltaCursor', undefined); await writeMeta(db, 'deltaPull', undefined); return { status: 'more', uploaded, downloaded }; }
    assertReply(reply); if (!validRevision(reply.revision) || typeof reply.fragment !== 'string') throw new Error('受信した差分を確認できません。');
    const fragment = (stage?.fragment ?? '') + reply.fragment;
    if (!reply.complete) { stage = { revision: reply.revision, offset: Number(reply.offset), fragment }; await writeMeta(db, 'deltaPull', stage); continue; }
    const rows = fragment ? JSON.parse(fragment) as RemoteRecordChange[] : [];
    if (rows.length) {
      const applied = await guards.apply(options => applyDeltaRows(db, connection, rows, reply.revision as number, options));
      if (!applied?.applied) return { status: 'deferred', uploaded, downloaded };
      downloaded += rows.length;
    } else { await writeMeta(db, 'deltaCursor', { connection, revision: reply.revision }); await writeMeta(db, 'deltaPull', undefined); }
    stage = undefined; cursor = { connection, revision: reply.revision };
    if (reply.revision === reply.head) return { status: 'done', uploaded, downloaded };
  }
  return { status: 'more', uploaded, downloaded };
}
