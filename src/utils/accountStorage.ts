import { decodeAccountValue, encodeAccountValue } from './accountStorageCodec';
import { isLearningStorageKey, LEARNING_MIGRATED_KEY } from './learningStorageKeys';
export type LocalAccountIdentity = { project: string; userId: string };
export type AccountStorageDecision = { identity: LocalAccountIdentity | null; namespace: string; legacyUnclaimed: boolean };
export const ACCOUNT_VAULT_MANIFEST_KEY = 'quizMakeAccountVault:v1';
export const accountGenerationKey = (identity: LocalAccountIdentity) => 'quizMakeAccountVault:generation:' + accountNamespace(identity);
export function readAccountGeneration(storage: Pick<Storage, 'getItem'>, identity: LocalAccountIdentity | null): string | null {
  if (!identity) return null;
  const value = storage.getItem(accountGenerationKey(identity));
  if (value !== null && !/^union-[a-f0-9-]{36}$/u.test(value)) throw new Error('移行後の端末保存先を確認できません。原本は保持しています。');
  return value;
}
const PREFIX = 'quiz-make-account-v1:';
const ownsKey = (key: string) => (key.startsWith('quizMake:') || key.startsWith('quiz-make')) && !key.startsWith(PREFIX);

export function validateLocalAccountIdentity(value: unknown): LocalAccountIdentity {
  if (!value || typeof value !== 'object') throw new Error('端末データの所有アカウントを確認できません。');
  const { project, userId } = value as LocalAccountIdentity;
  if (typeof project !== 'string' || typeof userId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(userId)) throw new Error('端末データの所有アカウントを確認できません。');
  const url = new URL(project);
  if (url.protocol !== 'https:' || url.origin !== project || url.username || url.password) throw new Error('端末データの所有アカウントを確認できません。');
  return { project, userId };
}
export const sameLocalAccount = (a: LocalAccountIdentity | null, b: LocalAccountIdentity | null) => a?.project === b?.project && a?.userId === b?.userId;
export const accountNamespace = (identity: LocalAccountIdentity) => encodeURIComponent(JSON.stringify([identity.project, identity.userId]));

/** Caller holds the origin data lock. A bound legacy store is adopted by its
 * recorded local owner, without copying/deleting records or authorizing RPCs. */
export function decideAccountStorage(storage: Pick<Storage, 'getItem' | 'setItem'>, identity: LocalAccountIdentity | null, legacyBinding: unknown): AccountStorageDecision {
  const account = identity ? validateLocalAccountIdentity(identity) : null;
  const raw = storage.getItem(ACCOUNT_VAULT_MANIFEST_KEY);
  let owner: LocalAccountIdentity | null = null;
  if (raw !== null) {
    const manifest = JSON.parse(raw) as { version?: unknown; legacyOwner?: unknown; archived?: unknown };
    if (!manifest || manifest.version !== 1 || !manifest.legacyOwner) throw new Error('端末データの所有記録を読み取れません。元のデータは保持しています。');
    owner = validateLocalAccountIdentity(manifest.legacyOwner);
  }
  const bound = legacyBinding ? validateLocalAccountIdentity(legacyBinding) : null;
  if (owner && bound && !sameLocalAccount(owner, bound)) throw new Error('端末データの所有記録と同期の接続先が一致しません。元のデータは保持しています。');
  if (!owner && bound) {
    const next = JSON.stringify({ version: 1, legacyOwner: bound });
    storage.setItem(ACCOUNT_VAULT_MANIFEST_KEY, next);
    if (storage.getItem(ACCOUNT_VAULT_MANIFEST_KEY) !== next) throw new Error('端末データの所有記録を保存できません。元のデータは保持しています。');
    owner = bound;
  }
  // Unclaimed local-only data remains available signed out. Login never silently adopts it.
  const archived = raw !== null && JSON.parse(raw).archived === true;
  const legacy = !readAccountGeneration(storage, account) && !archived && (owner ? sameLocalAccount(owner, account) : !account);
  return { identity: account, namespace: legacy ? 'legacy' : account ? accountNamespace(account) : 'guest', legacyUnclaimed: !owner };
}

export class AccountStorageSession {
  readonly identity: LocalAccountIdentity | null;
  readonly namespace: string;
  readonly legacyUnclaimed: boolean;
  private invalidated = false;
  private networkFenced = false;
  private readonly nativeStorage: Storage;
  readonly storage: Storage;
  readonly generation: string | null;
  readonly staging: boolean;
  private readonly expectedGeneration: string | null;
  private readonly decodedValues = new Map<string, { stored: string; raw: string }>();
  private windowLocks?: LockManager;
  private windowLease?: { release(): void; closed: Promise<void> };
  constructor(nativeStorage: Storage, decision: AccountStorageDecision, options: { generation?: string; staging?: boolean } = {}) {
    this.nativeStorage = nativeStorage;
    this.identity = decision.identity ? Object.freeze({ ...validateLocalAccountIdentity(decision.identity) }) : null;
    this.namespace = decision.namespace;
    this.legacyUnclaimed = decision.legacyUnclaimed;
    this.expectedGeneration = readAccountGeneration(nativeStorage, this.identity);
    this.generation = options.generation ?? this.expectedGeneration;
    this.staging = options.staging === true;
    if (this.generation !== null && !/^union-[a-f0-9-]{36}$/u.test(this.generation)) throw new Error('移行先の形式を確認できません。');
    if (options.generation && !this.staging) throw new Error('移行先は準備中として作成してください。');
    if (this.namespace !== 'legacy' && this.namespace !== 'guest' && (!this.identity || this.namespace !== accountNamespace(this.identity))) throw new Error('端末データの保存先を確認できません。');
    const owner = this;
    this.storage = {
      get length() { return owner.keys().length; },
      key(index: number) { return owner.keys()[index] ?? null; },
      getItem(key: string) { if (!ownsKey(key)) return null; const stored = owner.nativeStorage.getItem(owner.physicalKey(key));
        if (stored === null || !owner.generation) return stored; const cached = owner.decodedValues.get(key); if (cached?.stored === stored) return cached.raw;
        const raw = decodeAccountValue(stored); owner.decodedValues.set(key, { stored, raw }); return raw; },
      setItem(key: string, value: string) { owner.assertCurrent(); owner.assertKey(key); const raw = String(value); owner.nativeStorage.setItem(owner.physicalKey(key), owner.generation ? encodeAccountValue(raw) : raw); owner.decodedValues.delete(key); },
      removeItem(key: string) { owner.assertCurrent(); owner.assertKey(key); owner.nativeStorage.removeItem(owner.physicalKey(key)); owner.decodedValues.delete(key); },
      clear() { owner.assertCurrent(); for (const key of owner.keys()) owner.nativeStorage.removeItem(owner.physicalKey(key)); owner.decodedValues.clear(); },
    };
  }
  private assertKey(key: string) { if (!ownsKey(key)) throw new Error('アカウントの保存領域以外には書き込めません。'); }
  private scopedPrefix() { return PREFIX + this.namespace + (this.generation ? ':' + this.generation : '') + ':'; }
  private physicalKey(key: string) { return this.namespace === 'legacy' ? key : this.scopedPrefix() + key; }
  private keys() {
    const result: string[] = [];
    for (let i = 0; i < this.nativeStorage.length; i++) { const physical = this.nativeStorage.key(i); if (!physical) continue; const logical = this.eventKey(physical); if (logical) result.push(logical); }
    return result;
  }
  eventKey(physical: string | null): string | null {
    if (physical === null) return null;
    if (this.namespace === 'legacy') return ownsKey(physical) ? physical : null;
    const prefix = this.scopedPrefix();
    if (!this.generation && physical.startsWith(prefix + 'union-')) return null;
    return physical.startsWith(prefix) && ownsKey(physical.slice(prefix.length)) ? physical.slice(prefix.length) : null;
  }
  databaseName(base: string) {
    this.assertCurrent();
    if (!base.startsWith('quiz-make')) throw new Error('アカウントの保存領域以外には接続できません。');
    return this.namespace === 'legacy' ? base : this.scopedPrefix() + base;
  }
  assertCurrent(identity?: LocalAccountIdentity | null) {
    if (this.invalidated || identity !== undefined && !sameLocalAccount(this.identity, identity)) throw new Error('アカウントが変わりました。元の端末データは保持しています。');
    if (readAccountGeneration(this.nativeStorage, this.identity) !== this.expectedGeneration) throw new Error('端末の移行状態が変わりました。画面を開き直してください。原本は保持しています。');
    if(this.namespace==='legacy'){
      const raw=this.nativeStorage.getItem(ACCOUNT_VAULT_MANIFEST_KEY);
      if(raw){const manifest=JSON.parse(raw);if(manifest.version!==1||!sameLocalAccount(validateLocalAccountIdentity(manifest.legacyOwner),this.identity))throw new Error('端末データの所有者が変わりました。元の作業は保持しています。');}
      else if(!this.legacyUnclaimed)throw new Error('端末データの所有記録が変わりました。元の作業は保持しています。');
    }
  }
  assertNetworkCurrent(identity?: LocalAccountIdentity | null) {
    this.assertCurrent(identity);
    if (this.networkFenced) throw new Error('アカウントが変わりました。元の端末データは保持しています。');
  }
  fenceNetwork() { this.networkFenced = true; }
  resumeNetwork(identity: LocalAccountIdentity | null) { this.assertCurrent(identity); this.networkFenced = false; }
  async claimUnionWindow(locks = typeof navigator === 'undefined' ? undefined : navigator.locks): Promise<void> {
    this.assertCurrent(); if (!this.generation || this.staging || this.windowLease || !locks) return;
    this.windowLocks = locks; let release!: () => void, admit!: () => void, fail!: (error: unknown) => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>((resolve, reject) => { admit = resolve; fail = reject; });
    const closed = locks.request('quiz-make-union-window:' + this.namespace + ':' + this.generation, { mode: 'shared' }, async () => { admit(); await held; });
    void closed.catch(fail); this.windowLease = { release, closed };
    try { await ready; this.assertCurrent(); } catch (error) { release(); await closed.catch(() => {}); this.windowLease = undefined; throw error; }
  }
  /** Rollback must not strand unsaved input in another window of this generation.
   * Keep an exclusive lease through the pointer commit; a new window waits before
   * mounting and rechecks its captured generation after acquiring its lease. */
  async withExclusiveUnionWindow<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent(); const locks = this.windowLocks;
    if (!this.generation || !locks || !this.windowLease) throw new Error('巻き戻しに必要な画面間の保護を確認できません。原本は保持しています。');
    this.windowLease.release(); await this.windowLease.closed; this.windowLease = undefined;
    try { return await locks.request('quiz-make-union-window:' + this.namespace + ':' + this.generation, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('ほかのQuizMake画面がこの統合先を使用しています。入力を保管して閉じてから巻き戻してください。'); this.assertCurrent(); return operation(); });
    } finally { if (!this.invalidated && readAccountGeneration(this.nativeStorage, this.identity) === this.expectedGeneration) await this.claimUnionWindow(locks); }
  }
  invalidate() { this.invalidated = true; this.windowLease?.release(); }
}

let activeSession: AccountStorageSession | null = null;
/** One JS realm has one owner. Account changes must fence it and reload, never retarget pending async writes. */
export function activateAccountStorage(session: AccountStorageSession) {
  if (session.staging) throw new Error('準備中の移行先は利用できません。');
  if (activeSession && activeSession !== session) throw new Error('作業中の保存先は切り替えられません。先に作業を保管して画面を開き直してください。');
  activeSession = session;
}
export const getAccountStorageSession = () => activeSession;
export const accountDatabaseName = (base: string) => activeSession?.databaseName(base) ?? base;
export function assertAccountStorageCurrent(identity?: LocalAccountIdentity | null) { activeSession?.assertCurrent(identity); }
export function assertAccountNetworkCurrent(identity?: LocalAccountIdentity | null) { activeSession?.assertNetworkCurrent(identity); }
/** Native storage events carry physical keys; unrelated account changes must
 * never alter the active account's sync ID or settings. */
export function accountStorageEventKey(event: Pick<StorageEvent, 'key' | 'storageArea'>): string | null | undefined {
  if (event.storageArea && event.storageArea !== globalThis.localStorage) return undefined;
  if (event.key === null) return null;
  return activeSession ? activeSession.eventKey(event.key) ?? undefined : event.key;
}
/** Native values remain accessible only for verified migration and tiny settings. */
export const accountNativeStorage = () => activeSession?.storage ?? globalThis.localStorage;
let learningView: { owner: AccountStorageSession | null; native: Storage; values: Map<string, string | null> } | undefined;
function currentLearningView() {
  if (!learningView || learningView.owner !== activeSession || learningView.native !== globalThis.localStorage) return undefined;
  // Like native scoped reads, keep this owner's captured values readable while
  // a generation switch hides the screen and checkpoints unsaved input. Writes,
  // DB access, publishing and network requests still require the current owner.
  return learningView.values;
}
export function publishLearningStorage(values: Map<string, string | null>, owner = activeSession, native = globalThis.localStorage) {
  owner?.assertCurrent(); if (owner !== activeSession || native !== globalThis.localStorage) throw new Error('学習データの保存先が変わりました。原本は保持しています。');
  learningView = { owner, native, values: new Map(values) };
}
function localKeys() {
  const storage = accountNativeStorage(), values = currentLearningView(), keys = new Set<string>();
  for (let i = 0; i < (storage?.length ?? 0); i++) { const key = storage.key(i); if (key && (!values?.has(key) || values.get(key) !== null)) keys.add(key); }
  values?.forEach((raw, key) => { if (raw !== null) keys.add(key); else keys.delete(key); }); return [...keys];
}
export const accountLocalStorage: Storage = {
  get length() { return localKeys().length; },
  key(index) { return localKeys()[index] ?? null; },
  getItem(key) { const values = currentLearningView(); return values?.has(key) ? values.get(key)! : accountNativeStorage()?.getItem(key) ?? null; },
  setItem(key, value) { if (isLearningStorageKey(key) && (currentLearningView() || accountNativeStorage()?.getItem(LEARNING_MIGRATED_KEY) === '1')) throw new Error('学習データはIndexedDBへ保存してください。未保存の入力は保持しています。'); accountNativeStorage().setItem(key, value); },
  removeItem(key) { if (isLearningStorageKey(key) && (currentLearningView() || accountNativeStorage()?.getItem(LEARNING_MIGRATED_KEY) === '1')) throw new Error('学習データはIndexedDBの保存処理から削除してください。'); accountNativeStorage().removeItem(key); },
  clear() { if (currentLearningView()?.size) throw new Error('保存済み学習データを一括削除しません。'); accountNativeStorage().clear(); },
};
