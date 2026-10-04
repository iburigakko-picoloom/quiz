import { accountNamespace, sameLocalAccount, type AccountStorageSession, type LocalAccountIdentity } from './accountStorage';
export type AccountWorkSnapshot = { schema: 1; id: string; namespace: string; identity: LocalAccountIdentity | null; createdAt: string; work: Record<string, unknown>; resumed?: boolean };
const providers = new Map<string, () => unknown>();
const flushers = new Map<string, () => Promise<void>>();
let restored: AccountWorkSnapshot | null = null;
export function registerAccountWork(key: string, snapshot: () => unknown, flush?: () => Promise<void>) {
  providers.set(key, snapshot); if (flush) flushers.set(key, flush);
  return () => { if (providers.get(key) === snapshot) { providers.delete(key); flushers.delete(key); } };
}
export async function flushAccountWork() { for (const flush of flushers.values()) await flush(); }
export function captureAccountWork(session: AccountStorageSession): AccountWorkSnapshot {
  const work = Object.fromEntries([...providers].map(([key, snapshot]) => [key, snapshot()]));
  // Throws before reloading on non-persistable data. Never silently truncate a
  // draft, copy credential storage, or count this recovery copy as an answer.
  return structuredClone({ schema: 1, id: crypto.randomUUID(), namespace: session.namespace, identity: session.identity, createdAt: new Date().toISOString(), work });
}
export function restoreAccountWork(snapshot: AccountWorkSnapshot, session: AccountStorageSession) {
  if (snapshot.schema !== 1 || snapshot.namespace !== session.namespace || !sameLocalAccount(snapshot.identity,session.identity)) throw new Error('別のアカウントの作業は復元できません。');
  restored = snapshot;
}
export function getRestoredAccountWork<T>(key: string): T | undefined { return restored?.work[key] as T | undefined; }
export function consumeRestoredAccountWork(key: string) { if(restored)delete restored.work[key]; }
let reloadApproved = false;
export function approveAccountWorkReload() { reloadApproved = true; }
export const isAccountWorkReloadApproved = () => reloadApproved;
export const accountWorkDatabase = (session: AccountStorageSession) => session.databaseName('quiz-make-account-work-v1:'+(session.identity?accountNamespace(session.identity):'signed-out'));

/** Fingerprint bytes as well as fields: JSON alone silently discards imported files. */
async function workFingerprint(value: unknown): Promise<string> {
  if(value instanceof Blob){
    const bytes=await value.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    const file=typeof File!=='undefined'&&value instanceof File?[value.name,value.lastModified]:null;
    return JSON.stringify(['blob',value.type,value.size,file,hash]);
  }
  if(value instanceof Date)return JSON.stringify(['date',value.toISOString()]);
  if(Array.isArray(value))return '['+(await Promise.all(value.map(workFingerprint))).join(',')+']';
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean'||value===undefined)return JSON.stringify([typeof value,value]);
  if(typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+(await Promise.all(Object.keys(value).sort().map(async key=>JSON.stringify(key)+':'+await workFingerprint((value as Record<string,unknown>)[key])))).join(',')+'}';
  throw new Error('作業の控えに保存できない値があります。元の画面を保持しています。');
}

async function open(factory: IDBFactory, name: string, create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve,reject) => {
    const request = factory.open(name, create ? 1 : undefined); let absent = false, failed = false;
    request.onupgradeneeded = () => { if (!create) { absent = true; request.transaction?.abort(); } else request.result.createObjectStore('work', { keyPath: 'id' }); };
    request.onerror = () => { failed = true; if (absent) resolve(null); else reject(request.error ?? new Error('作業の控えを読み込めません。')); };
    request.onblocked = () => { failed = true; reject(new Error('作業の控えを開けません。別のQuizMake画面を閉じてください。')); };
    request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
  });
}
export async function saveAccountWork(factory: IDBFactory, databaseName: string, snapshot: AccountWorkSnapshot): Promise<void> {
  // databaseName was captured under the old owner before auth changed. This
  // dedicated recovery write cannot acquire the next account's namespace.
  const expected=await workFingerprint(snapshot);
  const db = await open(factory,databaseName,true); if (!db) throw new Error('作業の控えを保存できません。');
  try {
    await new Promise<void>((resolve,reject) => { const tx=db.transaction('work','readwrite');tx.objectStore('work').put(snapshot);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error ?? new Error('作業の控えを保存できません。')); });
    const checked = await new Promise<AccountWorkSnapshot | undefined>((resolve,reject) => { const tx=db.transaction('work'),request=tx.objectStore('work').get(snapshot.id);tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error); });
    if (await workFingerprint(checked)!==expected) throw new Error('作業の控えの保存を確認できません。元の画面を保持しています。');
  } finally { db.close(); }
}
export async function readLatestAccountWork(factory: IDBFactory, session: AccountStorageSession): Promise<AccountWorkSnapshot | null> {
  const db = await open(factory,accountWorkDatabase(session),false); if (!db) return null;
  try {
    return await new Promise<AccountWorkSnapshot|null>((resolve,reject)=>{
      let latest:AccountWorkSnapshot|null=null;
      const tx=db.transaction('work'),request=tx.objectStore('work').openCursor();
      request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;const item=cursor.value as AccountWorkSnapshot;
        if(item.schema!==1||item.namespace!==session.namespace||!sameLocalAccount(item.identity,session.identity)||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||!item.work||typeof item.work!=='object'){tx.abort();return;}
        if(!item.resumed&&(!latest||item.createdAt>latest.createdAt))latest=item;cursor.continue();};
      tx.oncomplete=()=>resolve(latest);tx.onabort=()=>reject(tx.error??new Error('作業の控えの所有記録を確認できません。原本は保持しています。'));
    });
  } finally { db.close(); }
}
