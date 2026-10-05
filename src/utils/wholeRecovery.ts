import { openAppDb } from '../storage';
import { withCoordinatedDataMutation } from './dataCoordination';
import type { FileBackup } from './backupPayload';

const INDEX = 'wholeRecoveryIndexV1';
const PREFIX = 'quizMake:wholeRecovery:';
export interface WholeRecoverySummary {
  id: string; createdAt: string; kind: 'before-restore' | 'conflict'; byteSize: number; digest: string;
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
export async function getWholeRecovery(id: string): Promise<string | undefined> {
  if (!id.startsWith(PREFIX)) throw new Error('復旧コピーのIDが不正です。');
  const db = await openAppDb(), tx = db.transaction('appDataBackups'), completed = done(tx), request = tx.objectStore('appDataBackups').get(id);
  await completed;
  if (request.result !== undefined && typeof request.result !== 'string') throw new Error('復旧コピーを読み込めません。');
  return request.result;
}
/** The first actual complete exchange determines this device's archive budget.
 * Four copies of the larger measured side, limited to half the free space,
 * leave room for live data and subsequent commits. The budget stays fixed until
 * the user explicitly deletes all copies; existing copies are never evicted. */
export async function prepareWholeRecovery(db: IDBDatabase, payload: FileBackup, kind: WholeRecoverySummary['kind'], replacementBytes=0): Promise<(tx: IDBTransaction) => void> {
  const { validateFileBackup } = await import('./backupPayload');
  const checked = await validateFileBackup(payload);
  if (!checked.ok || payload.backupManifest.completeness !== 'complete') throw new Error('完全な復旧コピーを検証できないため、データの入れ替えを中止しました。');
  const previous = await index(db), raw = JSON.stringify(payload), byteSize = new Blob([raw]).size;
  const duplicate = previous?.items.find(item => item.digest === payload.backupManifest.contentDigest);
  if (duplicate) {
    const stored = await getWholeRecovery(duplicate.id);
    const verified = stored ? await validateFileBackup(JSON.parse(stored)) : undefined;
    if (!verified?.ok || verified.value.payload.backupManifest.contentDigest !== duplicate.digest) throw new Error('既存の復旧コピーを確認できないため、データの入れ替えを中止しました。');
    return () => {};
  }
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (!estimate?.quota || estimate.usage === undefined || !Number.isFinite(estimate.quota - estimate.usage)) {
    throw new Error('端末の空き容量を確認できないため、復旧コピーを作成できません。');
  }
  const free = Math.max(0, estimate.quota - estimate.usage);
  if(!Number.isSafeInteger(replacementBytes)||replacementBytes<0)throw new Error('入れ替え後の容量を確認できません。');
  const budgetBytes = previous?.budgetBytes ?? Math.floor(Math.min(Math.max(byteSize,replacementBytes) * 4, free / 2));
  const used = previous?.items.reduce((sum, item) => sum + item.byteSize, 0) ?? 0;
  if (used + byteSize > budgetBytes || byteSize * 2 > free) throw new Error(`復旧コピーの容量が不足しています（使用 ${Math.ceil(used / 1048576)} MB／上限 ${Math.ceil(budgetBytes / 1048576)} MB）。必要なコピーを書き出してから、一覧で不要なコピーを削除してください。`);
  const summary: WholeRecoverySummary = { id: PREFIX + crypto.randomUUID(), createdAt: new Date().toISOString(), kind, byteSize, digest: payload.backupManifest.contentDigest };
  const next: RecoveryIndex = { version: 1, budgetBytes, items: [...previous?.items ?? [], summary] };
  return tx => {
    const current = tx.objectStore('appRecordMeta').get(INDEX);
    current.onsuccess = () => {
      try {
        if (JSON.stringify(current.result) !== JSON.stringify(previous)) throw new Error('復旧コピーの一覧が別の画面で更新されました。');
        tx.objectStore('appDataBackups').add(raw, summary.id);
        tx.objectStore('appRecordMeta').put(next, INDEX);
      } catch { tx.abort(); }
    };
  };
}
export async function deleteWholeRecovery(id: string): Promise<void> {
  await withCoordinatedDataMutation(['app', 'notes'], async () => {
    const db = await openAppDb(), previous = await index(db);
    if (!previous?.items.some(item => item.id === id)) throw new Error('復旧コピーが見つかりません。');
    const tx = db.transaction(['appDataBackups', 'appRecordMeta'], 'readwrite'), completed = done(tx);
    tx.objectStore('appDataBackups').delete(id);
    const items = previous.items.filter(item => item.id !== id);
    if (items.length) tx.objectStore('appRecordMeta').put({ ...previous, items }, INDEX);
    else tx.objectStore('appRecordMeta').delete(INDEX);
    await completed;
  }, { requireCrossContext: true });
}
