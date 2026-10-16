import { openAppDb } from '../storage';
import { withCoordinatedDataMutation } from './dataCoordination';
import type { FileBackup } from './backupPayload';
import { getAccountStorageSession } from './accountStorage';
import { hashBackupBlob, jsonBackupBlob } from './incrementalJsonDigest';
import { packBlobNote, parseBlobNote, queueBlobReferences, readMeta, unpackBlobNote, getContentBlob, blobHash } from './blobVault';

const INDEX = 'wholeRecoveryIndexV1';
const PREFIX = 'quizMake:wholeRecovery:';
export interface WholeRecoverySummary {
  id: string; createdAt: string; kind: 'before-restore' | 'conflict'; byteSize: number; digest: string;
  storageDigest?: string;
  blobVault?: true;
}
interface RecoveryIndex { version: 1; budgetBytes: number; items: WholeRecoverySummary[] }
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('復旧コピーを保存できませんでした。')); });
}
async function index(db: IDBDatabase): Promise<RecoveryIndex | undefined> {
  const tx = db.transaction('appRecordMeta'), completed = done(tx), request = tx.objectStore('appRecordMeta').get(INDEX);
  await completed;
  const value = request.result as RecoveryIndex | undefined;
  if (value && (value.version !== 1 || !Number.isSafeInteger(value.budgetBytes) || value.budgetBytes <= 0 || !Array.isArray(value.items)
    || value.items.some(row => !row.id.startsWith(PREFIX) || !Number.isSafeInteger(row.byteSize) || row.byteSize <= 0))) {
    throw new Error('復旧コピーの一覧を検証できません。既存コピーは削除せず保持しています。');
  }
  return value;
}
export async function listWholeRecovery(): Promise<WholeRecoverySummary[]> {
  return [...(await index(await openAppDb()))?.items ?? []].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function readRecoveryBody(db:IDBDatabase,id:string):Promise<string|Blob|undefined>{
  if (!id.startsWith(PREFIX)) throw new Error('復旧コピーのIDが不正です。');
  const tx = db.transaction('appDataBackups'), completed = done(tx), request = tx.objectStore('appDataBackups').get(id);
  await completed;
  if (request.result !== undefined && typeof request.result !== 'string' && !(request.result instanceof Blob)) throw new Error('復旧コピーを読み込めません。');
  return request.result;
}
export async function getWholeRecovery(id: string): Promise<string | undefined> {
  const db = await openAppDb(), body=await readRecoveryBody(db,id);
  const raw = body instanceof Blob ? await body.text() : body;
  return raw && parseBlobNote(raw) ? unpackBlobNote(db, raw, async ref => (await import('./blobCloud')).downloadContentBlob(ref)) : raw;
}
async function verifyRecovery(db:IDBDatabase,summary:WholeRecoverySummary):Promise<boolean>{
  const body=await readRecoveryBody(db,summary.id);
  if(body instanceof Blob){
    if(!summary.storageDigest||body.size!==summary.byteSize||await hashBackupBlob(body)!==summary.storageDigest)return false;
    const manifest=summary.blobVault?parseBlobNote(await body.text()):null;
    for(const ref of manifest?.blobs??[]){const blob=await getContentBlob(db,ref);if(!blob||await blobHash(blob)!==ref.sha256)return false;}
    return true;
  }
  if(typeof body!=='string')return false;
  const {validateFileBackup}=await import('./backupPayload');
  const checked=await validateFileBackup(JSON.parse(body),{retainImages:false});
  return checked.ok&&checked.value.payload.backupManifest.completeness==='complete'&&checked.value.payload.backupManifest.contentDigest===summary.digest;
}
/** The first actual complete exchange determines this device's archive budget.
 * Four copies of the larger measured side, limited to half the free space,
 * leave room for live data and subsequent commits. The budget stays fixed until
 * the history becomes empty. Retention runs only after a new complete copy has
 * committed and its exact contents have been reread; never to make a save fit. */
export async function prepareWholeRecovery(db: IDBDatabase, payload: FileBackup, kind: WholeRecoverySummary['kind'], replacementBytes=0): Promise<(tx: IDBTransaction) => void> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const currentOwner = () => { if(owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('復旧コピーのアカウントが変わりました。'); owner?.assertCurrent(); };
  currentOwner();
  const { validateFileBackup } = await import('./backupPayload');
  const checked = await validateFileBackup(payload,{retainImages:false});
  if (!checked.ok || payload.backupManifest.completeness !== 'complete') throw new Error('完全な復旧コピーを検証できないため、データの入れ替えを中止しました。');
  const previous = await index(db);
  const duplicate = previous?.items.find(item => item.digest === payload.backupManifest.contentDigest);
  if (duplicate) {
    if (!await verifyRecovery(db,duplicate)) throw new Error('既存の復旧コピーを確認できないため、データの入れ替えを中止しました。');
    currentOwner();return () => {currentOwner();};
  }
  const packed = await readMeta(db, 'deltaEnabled') ? await packBlobNote(db, JSON.stringify(payload), 'remote') : undefined;
  const stored = packed
    ? await jsonBackupBlob(JSON.parse(packed))
    : await jsonBackupBlob(payload);
  const byteSize=stored.blob.size;
  currentOwner();
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (!estimate?.quota || estimate.usage === undefined || !Number.isFinite(estimate.quota - estimate.usage)) {
    throw new Error('端末の空き容量を確認できないため、復旧コピーを作成できません。');
  }
  const free = Math.max(0, estimate.quota - estimate.usage);
  if(!Number.isSafeInteger(replacementBytes)||replacementBytes<0)throw new Error('入れ替え後の容量を確認できません。');
  const budgetBytes = previous?.budgetBytes ?? Math.floor(Math.min(Math.max(byteSize,replacementBytes) * 4, free / 2));
  const used = previous?.items.reduce((sum, item) => sum + item.byteSize, 0) ?? 0;
  if (used + byteSize > budgetBytes || byteSize * 2 > free) throw new Error(`復旧コピーの容量が不足しています（使用 ${Math.ceil(used / 1048576)} MB／上限 ${Math.ceil(budgetBytes / 1048576)} MB）。必要なコピーを書き出してから、一覧で不要なコピーを削除してください。`);
  const summary: WholeRecoverySummary = { id: PREFIX + crypto.randomUUID(), createdAt: new Date().toISOString(), kind, byteSize, digest: payload.backupManifest.contentDigest,storageDigest:stored.digest, ...(packed?{blobVault:true as const}:{}) };
  const next: RecoveryIndex = { version: 1, budgetBytes, items: [...previous?.items ?? [], summary] };
  return tx => {
    currentOwner();
    tx.addEventListener('complete', () => {
      void (async()=>{
        currentOwner();if(!await verifyRecovery(db,summary))return;currentOwner();
        const {pruneVerifiedBackupHistory}=await import('./backupHistory');
        await pruneVerifiedBackupHistory(summary.id,currentOwner);
      })().catch(() => { /* A failed cleanup retains the new copy and all remaining originals. */ });
    }, {once:true});
    const current = tx.objectStore('appRecordMeta').get(INDEX);
    current.onsuccess = () => {
      try {
        if (JSON.stringify(current.result) !== JSON.stringify(previous)) throw new Error('復旧コピーの一覧が別の画面で更新されました。');
        tx.objectStore('appDataBackups').add(stored.blob, summary.id);
        if (packed) queueBlobReferences(tx, `checkpoint:${summary.id}`, packed);
        tx.objectStore('appRecordMeta').put(next, INDEX);
      } catch { tx.abort(); }
    };
  };
}
export async function deleteWholeRecovery(id: string, options: {coordinationLockHeld?:boolean} = {}): Promise<void> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const current = () => { if(owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('復旧コピーのアカウントが変わりました。'); owner?.assertCurrent(); };
  const remove = async () => {
    current();
    const db = await openAppDb(), previous = await index(db);
    current();
    if (!previous?.items.some(item => item.id === id)) throw new Error('復旧コピーが見つかりません。');
    const tx = db.transaction(['appDataBackups', 'appRecordMeta', ...['contentBlobRefs'].filter(name=>db.objectStoreNames.contains(name))], 'readwrite'), completed = done(tx);
    tx.objectStore('appDataBackups').delete(id);
    if(tx.objectStoreNames.contains('contentBlobRefs'))tx.objectStore('contentBlobRefs').delete(`checkpoint:${id}`);
    const items = previous.items.filter(item => item.id !== id);
    if (items.length) tx.objectStore('appRecordMeta').put({ ...previous, items }, INDEX);
    else tx.objectStore('appRecordMeta').delete(INDEX);
    await completed;
  };
  if(options.coordinationLockHeld) await remove();
  else await withCoordinatedDataMutation(['app','notes'], remove, {requireCrossContext:true});
}
