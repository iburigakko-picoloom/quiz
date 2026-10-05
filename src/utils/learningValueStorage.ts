import { accountNativeStorage, getAccountStorageSession, publishLearningStorage, assertAccountStorageCurrent } from './accountStorage';
import { LEARNING_ORIGINAL_PREFIX, LEARNING_VALUE_PREFIX, LEARNING_MIGRATED_KEY, LEARNING_REQUIRED_KEY, LEARNING_REQUIRED_ROW, isLearningStorageKey } from './learningStorageKeys';
import { parsePlanDay, parseStudyPlan } from './studyPlans';
import { isChunkInternal, RECORD_CHUNK_GUARD_ID, RECORD_CHUNK_GUARD_RAW } from './recordChunkFormat';

export type LearningValue = { schema: 1; key: string; raw: string | null; sha256: string | null; nativeCleanup?: string };
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('学習データをIndexedDBへ保存できませんでした。原本は保持しています。')); });
const hash = async (raw: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(n => n.toString(16).padStart(2, '0')).join('');
function validate(key: string, raw: string | null) {
  if (!isLearningStorageKey(key) || isChunkInternal('localStorage', key)) throw new Error('学習データのキーを確認できません。');
  if (raw === null) return;
  if (key.startsWith('quizMake:plan:')) { if (parseStudyPlan(raw).id !== key.slice('quizMake:plan:'.length)) throw new Error('計画のIDが一致しません。'); }
  else if (key.startsWith('quizMake:planDay:')) { const day = parsePlanDay(raw); if (key !== 'quizMake:planDay:' + day.planId + ':' + day.day) throw new Error('日次目標のIDが一致しません。'); }
  else if (!Array.isArray(JSON.parse(raw))) throw new Error('メモの保存形式を確認できません。');
}
export async function prepareLearningValue(key: string, raw: string | null): Promise<LearningValue> {
  validate(key, raw); return { schema: 1, key, raw, sha256: raw === null ? null : await hash(raw) };
}
export function queueLearningValue(tx: IDBTransaction, value: LearningValue) { tx.objectStore('appData').put(value, LEARNING_VALUE_PREFIX + value.key); }
export function queueLearningFence(tx: IDBTransaction) {
  const store = tx.objectStore('localProjections'), current = store.get(LEARNING_REQUIRED_KEY);
  current.onsuccess = () => {
    const row = current.result;
    if (row !== undefined && !(row?.schema === 1 && row?.kind === LEARNING_REQUIRED_ROW.kind && Object.keys(row).length === 2)) { tx.abort(); return; }
    store.put(LEARNING_REQUIRED_ROW, LEARNING_REQUIRED_KEY);
  };
}
export async function readLearningValues(db: IDBDatabase): Promise<Map<string, LearningValue>> {
  const tx = db.transaction('appData'), completion = done(tx), store = tx.objectStore('appData'), range = IDBKeyRange.bound(LEARNING_VALUE_PREFIX, LEARNING_VALUE_PREFIX + '\uffff'), values = store.getAll(range), keys = store.getAllKeys(range);
  await completion; const result = new Map<string, LearningValue>();
  for (const [index, value] of (values.result as LearningValue[]).entries()) {
    if (value?.schema !== 1 || !(value.raw === null || typeof value.raw === 'string')) throw new Error('IndexedDBの学習データを検証できません。旧データは保持しています。');
    validate(value.key, value.raw); if (value.sha256 !== (value.raw === null ? null : await hash(value.raw))) throw new Error('学習データの照合に失敗しました。原本を削除せず確認を止めました。');
    if (keys.result[index] !== LEARNING_VALUE_PREFIX + value.key) throw new Error('学習データの保存先が一致しません。原本は保持しています。');
    if (value.nativeCleanup !== undefined && !/^[a-f0-9]{64}$/u.test(value.nativeCleanup)) throw new Error('旧データの移行記録を確認できません。');
    result.set(value.key, value);
  } return result;
}
/** Retains exact old text before any native cleanup. These rows are local only. */
export async function archiveNativeOriginals(db: IDBDatabase, entries: Record<string, string | null>): Promise<void> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage, values = await Promise.all(Object.entries(entries).filter((row): row is [string, string] => row[1] !== null).map(async ([key, raw]) => ({ key, raw, id: LEARNING_ORIGINAL_PREFIX + JSON.stringify([key, await hash(raw)]) })));
  if (!values.length) return;
  if (owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('保存先のアカウントが変わりました。旧データは保持しています。'); owner?.assertCurrent();
  const tx = db.transaction('appDataBackups', 'readwrite'), completion = done(tx);
  try { values.forEach(value => tx.objectStore('appDataBackups').put(value, value.id)); await completion; }
  catch (error) { try { tx.abort(); } catch { /* already complete */ } await completion.catch(() => {}); throw error; }
  const check = db.transaction('appDataBackups'), verified = done(check), requests = values.map(value => check.objectStore('appDataBackups').get(value.id)); await verified;
  if (requests.some((request, i) => request.result?.raw !== values[i].raw || request.result?.key !== values[i].key)) throw new Error('旧データの控えを検証できません。原本は保持しています。');
  if (owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('保存するアカウントが変わりました。旧データは保持しています。'); owner?.assertCurrent();
}
/** Optional cleanup never turns a completed main save into a fallback write. */
export async function cleanupNativeOriginals(db: IDBDatabase, entries: Record<string, string | null>): Promise<void> {
  const owner = getAccountStorageSession(), nativeIdentity = globalThis.localStorage, native = accountNativeStorage();
  try {
    await archiveNativeOriginals(db, entries);
    if (owner !== getAccountStorageSession() || nativeIdentity !== globalThis.localStorage) return;
    owner?.assertCurrent();
    for (const [key, raw] of Object.entries(entries)) if (raw !== null && native.getItem(key) === raw) native.removeItem(key);
  } catch { /* Keep every unverified original. A later successful save retries cleanup. */ }
}
export async function refreshLearningStorage(db: IDBDatabase): Promise<void> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage, rows = await readLearningValues(db); owner?.assertCurrent();
  publishLearningStorage(new Map([...rows].map(([key, value]) => [key, value.raw])), owner, native);
}
/** Caller holds the origin lock. Pending projections are known saved attempts;
 * differing unmarked native/record copies are retained rather than guessed. */
export async function migrateLearningStorage(db: IDBDatabase): Promise<void> {
  const owner = getAccountStorageSession(), nativeIdentity = globalThis.localStorage, native = accountNativeStorage();
  const before = new Map<string, string>();
  for (let i = 0; i < native.length; i++) { const key = native.key(i); if (key && isLearningStorageKey(key) && !isChunkInternal('localStorage', key)) { const raw = native.getItem(key); if (raw !== null) before.set(key, raw); } }
  const oldRows = await readLearningValues(db), previous = new Map([...oldRows].map(([key, value]) => [key, value.raw])), tx = db.transaction(['appRecords', 'localProjections']), completion = done(tx);
  const records = tx.objectStore('appRecords').getAll(IDBKeyRange.bound('["localStorage",', '["localStorage",\uffff'));
  const pendingKeys = tx.objectStore('localProjections').getAllKeys(), pendingValues = tx.objectStore('localProjections').getAll(); await completion;
  const canonical = new Map<string, string | null>(records.result.filter(row => isLearningStorageKey(row.id) && !isChunkInternal('localStorage', row.id)).map(row => [row.id, row.logicalRaw ?? row.raw]));
  const pending = new Map<string, string | null>(); pendingKeys.result.forEach((key, i) => { if (typeof key === 'string' && isLearningStorageKey(key) && !isChunkInternal('localStorage', key)) pending.set(key, pendingValues.result[i]); });
  const next = new Map(previous);
  for (const key of new Set([...before.keys(), ...canonical.keys(), ...pending.keys()])) {
    const record = canonical.get(key), legacy = before.get(key);
    if (pending.has(key)) { if (!canonical.has(key) || pending.get(key) !== record) throw new Error('保存待ちの計画・メモと保存本体が異なります。両方の原本は保持しています。'); next.set(key, record!); }
    else if (canonical.has(key)) {
      if (!previous.has(key) && legacy !== undefined && legacy !== record) throw new Error('旧端末データとIndexedDBの内容が異なります。原本を保持して確認を止めました。');
      next.set(key, record!);
    } else if (legacy !== undefined && !previous.has(key)) next.set(key, legacy);
    if (previous.has(key) && legacy !== undefined && legacy !== previous.get(key) && !pending.has(key) && oldRows.get(key)?.nativeCleanup !== await hash(legacy)) throw new Error('移行後に旧保存領域が変更されました。両方のデータを保持しています。');
  }
  const writes = await Promise.all([...next].filter(([key, raw]) => !previous.has(key) || previous.get(key) !== raw || before.has(key)).map(async ([key, raw]) => ({ ...await prepareLearningValue(key, raw), ...(before.has(key) ? {nativeCleanup: await hash(before.get(key)!)} : {}) })));
  owner?.assertCurrent(); assertAccountStorageCurrent(); await archiveNativeOriginals(db, Object.fromEntries(before));
  const commit = db.transaction(['appData', 'appRecords', 'localProjections'], 'readwrite'), saved = done(commit);
  try {
    writes.forEach(value => queueLearningValue(commit, value));
    if (next.size) queueLearningFence(commit);
    canonical.forEach((raw, key) => { const request = commit.objectStore('appRecords').get(JSON.stringify(['localStorage', key])); request.onsuccess = () => { if ((request.result?.logicalRaw ?? request.result?.raw) !== raw) commit.abort(); }; });
    pending.forEach((raw, key) => { const request = commit.objectStore('localProjections').get(key); request.onsuccess = () => { if (request.result !== raw) { commit.abort(); return; } commit.objectStore('localProjections').delete(key); }; });
    await saved;
  } catch (error) { try { commit.abort(); } catch { /* already complete */ } await saved.catch(() => {}); throw error; }
  const checked = await readLearningValues(db); if ([...next].some(([key, raw]) => checked.get(key)?.raw !== raw)) throw new Error('移行済みの計画・メモを照合できません。旧データは削除していません。');
  if (owner !== getAccountStorageSession() || nativeIdentity !== globalThis.localStorage) throw new Error('移行中にアカウントが変わりました。原本は保持しています。'); owner?.assertCurrent();
  if ([...before].some(([key, raw]) => native.getItem(key) !== raw)) throw new Error('移行中に旧保存領域が変更されました。両方の原本は保持しています。');
  publishLearningStorage(new Map([...checked].map(([key, value]) => [key, value.raw])), owner, nativeIdentity);
  if (checked.size && native.getItem(LEARNING_MIGRATED_KEY) !== '1') {
    native.setItem(LEARNING_MIGRATED_KEY, '1');
    if (native.getItem(LEARNING_MIGRATED_KEY) !== '1') throw new Error('移行状態を保存できません。旧データは保持しています。');
  }
  // Published plan-aware Snapshot clients reject this existing compatibility
  // guard. It prevents an old tab/downgrade from exporting missing native plans.
  if (checked.size && native.getItem(RECORD_CHUNK_GUARD_ID) !== RECORD_CHUNK_GUARD_RAW) {
    native.setItem(RECORD_CHUNK_GUARD_ID, RECORD_CHUNK_GUARD_RAW);
    if (native.getItem(RECORD_CHUNK_GUARD_ID) !== RECORD_CHUNK_GUARD_RAW) throw new Error('旧版との保存保護を確認できません。原本は保持しています。');
  }
  // Remove only exact values with a verified durable original and new value.
  const cleaned: string[] = [];
  for (const [key, raw] of before) { try { if (native.getItem(key) === raw) native.removeItem(key); if (native.getItem(key) === null) cleaned.push(key); } catch { /* Verified IDB value/original and exact cleanup marker remain restartable. */ } }
  if (cleaned.length) {
    const clear = db.transaction('appData', 'readwrite'), cleared = done(clear);
    cleaned.forEach(key => { const request = clear.objectStore('appData').get(LEARNING_VALUE_PREFIX + key); request.onsuccess = () => { if (request.result?.nativeCleanup === checked.get(key)?.nativeCleanup) { const {nativeCleanup: _cleanup, ...value} = request.result as LearningValue; clear.objectStore('appData').put(value, LEARNING_VALUE_PREFIX + key); } }; });
    await cleared;
  }
}
