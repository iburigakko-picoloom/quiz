import { loadCategoryNoteRaw, saveCategoryNoteRaw, waitForPendingCategoryNoteSaves, replaceNoteAndDeleteKeys } from './noteStorage';
import { createId } from './id';
import { validMaterialRecord, MAX_MATERIAL_PDF_BYTES, type MaterialIndex, type MaterialFile, type StudyMaterial } from './materialModel';
import { createMaterialTransport, hydrateMaterialDownload } from './materialCloud';
import { withCoordinatedDataMutation } from './dataCoordination';
import { openAppDb, loadAppDataAsync, waitForPendingAppDataSaves } from '../storage';
import { blobDataUrl, getContentBlob, idbDone, idbResult, packBlobNote, parseBlobNote, putContentBlob, readMeta, setBlobOffline, trimBlobCache, writeMeta, unpackBlobNote, type BlobRef } from './blobVault';
import { getAccountStorageSession } from './accountStorage';

/** A legacy downloaded projection can be newer than its remote descriptor.
 * Reuse it only when the content hash matches; never turn it into a new edit. */
export async function recoverCachedMaterial(db: IDBDatabase, key: string, ref: BlobRef): Promise<Blob | undefined> {
  const owner = getAccountStorageSession();
  const tx = db.transaction('appDataBackups'), done = idbDone(tx);
  const keys = await idbResult(tx.objectStore('appDataBackups').getAllKeys()); await done;
  for (const id of keys.filter(id => String(id).startsWith(`delta-note-original:${key}:`) || String(id).startsWith(`note-rescue:${key}:`))) {
    const read = db.transaction('appDataBackups'), completed = idbDone(read);
    const stored = await idbResult(read.objectStore('appDataBackups').get(id)); await completed;
    const raw = stored instanceof Blob ? await stored.text() : stored;
    if (typeof raw !== 'string') continue;
    let candidate: MaterialFile;
    try { candidate = JSON.parse(await unpackBlobNote(db, raw)); } catch { continue; }
    if (candidate.kind !== 'quiz-material-file' || !validMaterialRecord(candidate as unknown as Record<string,unknown>)) continue;
    const bytes = Uint8Array.from(atob(candidate.dataUrl.slice(candidate.dataUrl.indexOf(',')+1)), char=>char.charCodeAt(0));
    const blob = new Blob([bytes], { type: ref.type });
    if (owner !== getAccountStorageSession()) throw new Error('PDFのアカウントが変わりました。'); owner?.assertCurrent();
    // A mismatch is an unrelated historical version, which remains protected.
    if (blob.size !== ref.size || await (await import('./blobVault')).blobHash(blob) !== ref.sha256) continue;
    await putContentBlob(db, blob, { expected: ref, origin: 'local' }); return blob;
  }
}

export const materialIndexKey = (setId: string) => `quizMake:notes:${setId}:__materials_v1`;
export const materialFileKey = (setId: string, materialId: string) => `quizMake:notes:${setId}:__material_pdf_${materialId}`;
export const annotationCategory = (materialId: string, pageId: string) => `__material_ink_${materialId}_${pageId}`;
export async function loadMaterials(setId: string): Promise<MaterialIndex> {
  const raw = await loadCategoryNoteRaw(materialIndexKey(setId));
  if (!raw) return { kind: 'quiz-material-index', version: 1, problemSetId: setId, materials: [], updatedAt: new Date().toISOString() };
  const parsed = JSON.parse(raw);
  if (!validMaterialRecord(parsed) || parsed.kind !== 'quiz-material-index') throw new Error('資料情報を読み込めません。上書きせず、再読み込みしてください。');
  return parsed;
}
export async function saveMaterials(index: MaterialIndex) {
  if (!validMaterialRecord(index as unknown as Record<string, unknown>)) throw new Error('資料情報が不正です。');
  await saveCategoryNoteRaw(materialIndexKey(index.problemSetId), JSON.stringify({ ...index, updatedAt: new Date().toISOString() }));
}

export async function deleteMaterial(setId: string, materialId: string): Promise<MaterialIndex> {
  const [ready] = await Promise.all([waitForPendingAppDataSaves(), waitForPendingCategoryNoteSaves()]);
  if (!ready) throw new Error('未保存の変更があります。保存を確認してから削除してください。');
  return withCoordinatedDataMutation(['app', 'notes'], async () => {
    const data = await loadAppDataAsync({ coordinationLockHeld: true });
    const raw = await loadCategoryNoteRaw(materialIndexKey(setId), { coordinationLockHeld: true });
    const index = raw ? JSON.parse(raw) as MaterialIndex : null;
    if (!index || index.kind !== 'quiz-material-index' || index.problemSetId !== setId || !validMaterialRecord(index as unknown as Record<string, unknown>)) throw new Error('資料一覧を確認できません。開き直してください。');
    const material = index.materials.find(item => item.id === materialId);
    if (!material) throw new Error('資料が変更されています。開き直してください。');
    const references = data.questions.filter(q => q.materialReferences?.some(r => r.materialId === materialId));
    if (references.length) {
      const names = [...new Set(references.map(q => data.problemSets.find(s => s.id === q.setId)?.title ?? q.setId))];
      throw new Error(`「${names.join('」「')}」の${references.length}問が参照しています。「参照ページを調整」→「参照を解除」で解除してから削除してください。`);
    }
    const next = { ...index, materials: index.materials.filter(item => item.id !== materialId), updatedAt: new Date().toISOString() };
    const keys = [materialFileKey(setId, materialId), ...material.pages.map(page => `quizMake:notes:${setId}:${annotationCategory(materialId, page.id)}`)];
    await replaceNoteAndDeleteKeys(materialIndexKey(setId), JSON.stringify(next), keys);
    return next;
  }, { requireCrossContext: true });
}
export async function loadMaterialFile(setId: string, id: string): Promise<string> {
  const key = materialFileKey(setId, id);
  let raw = await loadCategoryNoteRaw(key);
  if (raw) {
    const candidate = JSON.parse(raw);
    if (candidate?.kind === 'quiz-material-remote-file') {
      if (!validMaterialRecord(candidate)) throw new Error('PDFの参照が不正です。');
      const db = await openAppDb();
      const ref: BlobRef = { sha256: candidate.sha256, size: candidate.size, type: 'application/pdf' };
      const cached = await getContentBlob(db, ref);
      if (cached) return blobDataUrl(new Blob([cached], { type: ref.type }));
      const recovered = await recoverCachedMaterial(db, key, ref);
      if (recovered) return blobDataUrl(recovered);
      const {getRemoteSyncConfig}=await import('./syncService'),{getCloudAccessToken}=await import('./cloudService');
      const config = getRemoteSyncConfig();
      const access = await getCloudAccessToken();
      if (!config || !access.ok) throw new Error('PDFを取得するにはログインが必要です。');
      if (await readMeta(db, 'deltaEnabled')) {
        const bytes = await createMaterialTransport(config, access).download(candidate);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        await putContentBlob(db, blob, { origin: 'remote', expected: ref });
        await writeMeta(db, `materialCache:${key}`, ref);
        await trimBlobCache(db);
        return blobDataUrl(blob);
      }
      const result = await hydrateMaterialDownload({ version: 1, updatedAt: '', localStorage: {}, indexedDbNotes: { [key]: raw } },
        createMaterialTransport(config,access));
      const hydrated = result.indexedDbNotes?.[key];
      if (!hydrated) throw new Error('PDFのダウンロードを完了できませんでした。');
      await withCoordinatedDataMutation(['notes'], async()=>{
        const db = await openAppDb();
        const tx = db.transaction('categoryNotes','readwrite');
        const completed = new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('PDFの一時保存に失敗しました。'));});
        const current = tx.objectStore('categoryNotes').get(key);
        current.onsuccess=()=>{
          if(current.result!==raw){tx.abort();return;}
          tx.objectStore('categoryNotes').put(hydrated,key);
        };
        await completed;
      },{requireCrossContext:true});
      raw = hydrated;
    }
  }
  const file = raw ? JSON.parse(raw) as MaterialFile : null;
  if (!file || !validMaterialRecord(file as unknown as Record<string, unknown>)) throw new Error('PDF本体が見つかりません。資料を保存した端末のバックアップを確認してください。');
  return file.dataUrl;
}
export async function isMaterialOffline(setId: string, id: string): Promise<boolean> {
  return Boolean(await readMeta(await openAppDb(), `materialOffline:${materialFileKey(setId, id)}`));
}
export async function setMaterialOffline(setId: string, id: string, offline: boolean): Promise<void> {
  const key = materialFileKey(setId, id), db = await openAppDb();
  if (offline) await loadMaterialFile(setId, id);
  const tx = db.transaction('categoryNotes', 'readonly'), done = idbDone(tx);
  const raw = await idbResult<string | undefined>(tx.objectStore('categoryNotes').get(key)); await done;
  let refs = parseBlobNote(raw ?? null)?.blobs;
  if (!refs && raw) {
    const value = JSON.parse(raw);
    if (value.kind === 'quiz-material-remote-file') refs = [{ sha256: value.sha256, size: value.size, type: 'application/pdf' }];
    else refs = parseBlobNote(await packBlobNote(db, raw))?.blobs;
  }
  if (offline && !refs?.length) throw new Error('オフライン保存するPDFを確認できません。');
  await setBlobOffline(db, refs ?? [], offline); await writeMeta(db, `materialOffline:${key}`, offline);
  if (!offline) await trimBlobCache(db);
}
export async function storeMaterialPdf(setId: string, file: File, pageCount: number): Promise<StudyMaterial> {
  if (!file.size || file.size > MAX_MATERIAL_PDF_BYTES) throw new Error('PDFは1ファイル50MB以下にしてください。');
  const id = createId('material');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('PDFを読み込めません。'));
    reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(new Blob([file], { type: 'application/pdf' }));
  });
  await saveCategoryNoteRaw(materialFileKey(setId, id), JSON.stringify({ kind: 'quiz-material-file', version: 1, materialId: id, dataUrl, updatedAt: new Date().toISOString() }));
  return { id, title: file.name, pages: Array.from({ length: pageCount }, (_, index) => ({ id: createId('page'), kind: 'pdf' as const, pdfPage: index + 1 })) };
}
