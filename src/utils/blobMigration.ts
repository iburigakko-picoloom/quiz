import { appRecordKey, type AppRecord, type AppOutboxOperation } from './appRecordStorage';
import { idbDone, idbResult, packBlobNote, queueBlobReferences, queueBlobUploads, readMeta, writeMeta, BLOB_STORES, putContentBlob, queueContentUpload } from './blobVault';
import { categoryNoteRecoveryKeys } from './noteStorage';
type Unit = { current?: string; backup?: string; record?: AppRecord; history?: AppRecord; pending?: AppOutboxOperation; versions?: AppRecord[] };
/** One note and every version in its local stores are one migration unit.
 * Originals are replaced only after all blobs have survived read-back hashing.
 * An uncertain legacy/delta request is immutable and delays conversion. */
export async function migrateNoteBlobs(db: IDBDatabase, assertCurrent: () => Promise<void>, limit = 4): Promise<boolean> {
  if (await readMeta(db, 'wholeFrozen') || await readMeta(db, 'pushBatch') || await readMeta(db, 'deltaFrozen')) return false;
  const marker = await readMeta<{ after: string; complete?: boolean }>(db, 'blobMigration');
  if (marker?.complete) return true;
  const read = db.transaction(['categoryNotes', 'categoryNoteBackups'], 'readonly'), done = idbDone(read);
  const current = read.objectStore('categoryNotes').getAllKeys(), backups = read.objectStore('categoryNoteBackups').getAllKeys(); await done;
  const ids = [...new Set([...current.result, ...backups.result].map(String))].filter(id => id > (marker?.after ?? '')).sort().slice(0, limit);
  for (const id of ids) {
    await assertCurrent(); const key = appRecordKey('indexedDbNotes', id);
    const stores = ['categoryNotes', 'categoryNoteBackups', 'appRecords', 'appRecordBackups', 'appOutbox', 'appRecordMeta', 'recordHistory', ...BLOB_STORES];
    const source = db.transaction(stores, 'readonly'), sourced = idbDone(source);
    const requests = [source.objectStore('categoryNotes').get(id), source.objectStore('categoryNoteBackups').get(id), source.objectStore('appRecords').get(key), source.objectStore('appRecordBackups').get(key), source.objectStore('appOutbox').get(key), source.objectStore('recordHistory').get(key)];
    const values = await Promise.all(requests.map(idbResult)); await sourced;
    const unit: Unit = { current: values[0], backup: values[1], record: values[2], history: values[3], pending: values[4], versions: values[5] };
    const convertRow = async <T extends { raw: string | null; logicalRaw?: string; baseContent?: { raw: string | null; position: number } }>(row?: T): Promise<T | undefined> => {
      if (!row) return row;
      const raw = row.logicalRaw ?? row.raw;
      const result = { ...row, raw: raw ? await packBlobNote(db, raw) : raw, transferReady:1 as const };
      if (result.raw !== row.raw) delete result.logicalRaw;
      if (row.baseContent?.raw) result.baseContent = { ...row.baseContent, raw: await packBlobNote(db, row.baseContent.raw) };
      return result;
    };
    // Backup-only candidates are converted in place but never turned into records or edits.
    const converted: Unit = { current: unit.current ? await packBlobNote(db, unit.current) : undefined,
      backup: unit.backup ? await packBlobNote(db, unit.backup) : undefined,
      record: await convertRow(unit.record), history: await convertRow(unit.history), pending: await convertRow(unit.pending), versions: await Promise.all((unit.versions??[]).map(async row=>(await convertRow(row))!)) };
    await assertCurrent();
    const tx = db.transaction(stores, 'readwrite'), completed = idbDone(tx);
    const checks = [tx.objectStore('categoryNotes').get(id), tx.objectStore('categoryNoteBackups').get(id), tx.objectStore('appRecords').get(key), tx.objectStore('appRecordBackups').get(key), tx.objectStore('appOutbox').get(key), tx.objectStore('recordHistory').get(key)];
    const frozen = ['wholeFrozen', 'pushBatch', 'deltaFrozen'].map(k => tx.objectStore('appRecordMeta').get(k));
    const state = tx.objectStore('appRecordMeta').get('state');
    state.onsuccess = () => {
      if (checks.some((r, i) => JSON.stringify(r.result) !== JSON.stringify(values[i])) || frozen.some(r => r.result)) { tx.abort(); return; }
      for (const [store, value, old, recordKey] of [
        ['categoryNotes', converted.current, unit.current, id], ['categoryNoteBackups', converted.backup, unit.backup, id],
        ['appRecords', converted.record, unit.record, key], ['appRecordBackups', converted.history, unit.history, key], ['appOutbox', converted.pending, unit.pending, key],
      ] as const) if (value !== undefined && JSON.stringify(value) !== JSON.stringify(old)) tx.objectStore(store).put(value, recordKey);
      if (converted.record && converted.record.raw !== unit.record?.raw && !unit.pending && !categoryNoteRecoveryKeys().includes(id)) {
        tx.objectStore('appOutbox').put({ ...converted.record, operationId: crypto.randomUUID(), baseRevision: converted.record.serverRevision, representationOnly: true, transferReady:1 }, key);
      }
      for (const [name, raw] of [['current', converted.current], [unit.record?'note-backup':'rescue', converted.backup], ['record-history', converted.history?.raw], ['pending', converted.pending?.raw]] as const) {
        if (raw) { queueBlobReferences(tx, `${name}:${key}`, raw, name !== 'current'); queueBlobUploads(tx, raw); }
      }
      if (converted.record?.raw) queueBlobUploads(tx, converted.record.raw);
      if(converted.versions?.length){tx.objectStore('recordHistory').put(converted.versions,key);converted.versions.forEach((row,i)=>queueBlobReferences(tx,`history:${key}:${i}`,row.raw));}
      if (state.result) tx.objectStore('appRecordMeta').put({ ...state.result, commitId: crypto.randomUUID() }, 'state');
      tx.objectStore('appRecordMeta').put({ after: id, verified: true }, 'blobMigration');
    };
    await completed;
  }
  if (ids.length < limit) await writeMeta(db, 'blobMigration', { after: ids[ids.length - 1] ?? marker?.after ?? '', complete: true });
  return ids.length < limit;
}

/** Each image switches only after bytes have been reread and hashed. Descriptors
 * retain their old remote path, so another device can still read the old copy. */
export async function migrateImageBlobs(db: IDBDatabase, assertCurrent: () => Promise<void>, limit = 4): Promise<boolean> {
  for (const key of ['wholeFrozen','pushBatch','deltaFrozen']) if (await readMeta(db,key)) return false;
  const marker = await readMeta<{ after: string; complete?: boolean }>(db,'imageBlobMigration');
  if (marker?.complete) return true;
  const read = db.transaction('questionImageBlobs'), done = idbDone(read);
  const ids = await idbResult<IDBValidKey[]>(read.objectStore('questionImageBlobs').getAllKeys()); await done;
  const selected = ids.map(String).filter(id=>id>(marker?.after??'')).sort().slice(0,limit);
  for (const id of selected) {
    await assertCurrent(); const key = appRecordKey('questionImages',id);
    const source = db.transaction(['questionImageBlobs','appRecords','appOutbox']), sourced=idbDone(source);
    const image = source.objectStore('questionImageBlobs').get(id), record=source.objectStore('appRecords').get(key), pending=source.objectStore('appOutbox').get(key); await sourced;
    if (!(image.result?.blob instanceof Blob)) { await writeMeta(db,'imageBlobMigration',{after:id}); continue; }
    const ref = await putContentBlob(db,image.result.blob);
    const descriptor = record.result?.raw ? JSON.parse(record.result.raw) : null;
    if (!descriptor || descriptor.sha256!==ref.sha256 || descriptor.size!==ref.size) throw new Error('画像の原本と同期レコードを照合できません。原本を保持しています。');
    const raw = JSON.stringify({...descriptor,vault:true}); await assertCurrent();
    const tx = db.transaction(['questionImageBlobs','appRecords','appOutbox','appRecordMeta',...BLOB_STORES],'readwrite'), completed=idbDone(tx);
    const check=tx.objectStore('appRecords').get(key), queued=tx.objectStore('appOutbox').get(key);
    const frozen=['wholeFrozen','pushBatch','deltaFrozen'].map(k=>tx.objectStore('appRecordMeta').get(k));
    const state=tx.objectStore('appRecordMeta').get('state');
    state.onsuccess=()=>{
      if(check.result?.raw!==record.result?.raw || queued.result?.operationId!==pending.result?.operationId || frozen.some(r=>r.result)){tx.abort();return;}
      const {blob:_blob,...metadata}=image.result;
      tx.objectStore('questionImageBlobs').put({...metadata,vaultRef:ref},id);
      tx.objectStore('appRecords').put({...record.result,raw},key);
      tx.objectStore('appOutbox').put(pending.result?{...pending.result,raw}:{...record.result,raw,operationId:crypto.randomUUID(),baseRevision:record.result.serverRevision,representationOnly:true},key);
      queueBlobReferences(tx,`image:${id}`,raw);queueContentUpload(tx,ref);
      if(state.result)tx.objectStore('appRecordMeta').put({...state.result,commitId:crypto.randomUUID()},'state');
      tx.objectStore('appRecordMeta').put({after:id,verified:true},'imageBlobMigration');
    };await completed;
  }
  if(selected.length<limit)await writeMeta(db,'imageBlobMigration',{after:selected[selected.length-1]??marker?.after??'',complete:true});
  return selected.length<limit;
}
