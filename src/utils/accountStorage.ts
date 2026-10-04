export type LocalAccountIdentity = { project: string; userId: string };
export type AccountStorageDecision = { identity: LocalAccountIdentity | null; namespace: string; legacyUnclaimed: boolean };
export const ACCOUNT_VAULT_MANIFEST_KEY = 'quizMakeAccountVault:v1';
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
    const manifest = JSON.parse(raw) as { version?: unknown; legacyOwner?: unknown };
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
  const legacy = owner ? sameLocalAccount(owner, account) : !account;
  return { identity: account, namespace: legacy ? 'legacy' : account ? accountNamespace(account) : 'guest', legacyUnclaimed: !owner };
}

export class AccountStorageSession {
  readonly identity: LocalAccountIdentity | null;
  readonly namespace: string;
  private invalidated = false;
  private networkFenced = false;
  private readonly nativeStorage: Storage;
  readonly storage: Storage;
  constructor(nativeStorage: Storage, decision: AccountStorageDecision) {
    this.nativeStorage = nativeStorage;
    this.identity = decision.identity ? Object.freeze({ ...validateLocalAccountIdentity(decision.identity) }) : null;
    this.namespace = decision.namespace;
    if (this.namespace !== 'legacy' && this.namespace !== 'guest' && (!this.identity || this.namespace !== accountNamespace(this.identity))) throw new Error('端末データの保存先を確認できません。');
    const owner = this;
    this.storage = {
      get length() { return owner.keys().length; },
      key(index: number) { return owner.keys()[index] ?? null; },
      getItem(key: string) { return ownsKey(key) ? owner.nativeStorage.getItem(owner.physicalKey(key)) : null; },
      setItem(key: string, value: string) { owner.assertCurrent(); owner.assertKey(key); owner.nativeStorage.setItem(owner.physicalKey(key), value); },
      removeItem(key: string) { owner.assertCurrent(); owner.assertKey(key); owner.nativeStorage.removeItem(owner.physicalKey(key)); },
      clear() { owner.assertCurrent(); for (const key of owner.keys()) owner.nativeStorage.removeItem(owner.physicalKey(key)); },
    };
  }
  private assertKey(key: string) { if (!ownsKey(key)) throw new Error('アカウントの保存領域以外には書き込めません。'); }
  private physicalKey(key: string) { return this.namespace === 'legacy' ? key : PREFIX + this.namespace + ':' + key; }
  private keys() {
    const result: string[] = [];
    for (let i = 0; i < this.nativeStorage.length; i++) { const physical = this.nativeStorage.key(i); if (!physical) continue; const logical = this.eventKey(physical); if (logical) result.push(logical); }
    return result;
  }
  eventKey(physical: string | null): string | null {
    if (physical === null) return null;
    if (this.namespace === 'legacy') return ownsKey(physical) ? physical : null;
    const prefix = PREFIX + this.namespace + ':';
    return physical.startsWith(prefix) && ownsKey(physical.slice(prefix.length)) ? physical.slice(prefix.length) : null;
  }
  databaseName(base: string) {
    this.assertCurrent();
    if (!base.startsWith('quiz-make')) throw new Error('アカウントの保存領域以外には接続できません。');
    return this.namespace === 'legacy' ? base : PREFIX + this.namespace + ':' + base;
  }
  assertCurrent(identity?: LocalAccountIdentity | null) {
    if (this.invalidated || identity !== undefined && !sameLocalAccount(this.identity, identity)) throw new Error('アカウントが変わりました。元の端末データは保持しています。');
  }
  assertNetworkCurrent(identity?: LocalAccountIdentity | null) {
    this.assertCurrent(identity);
    if (this.networkFenced) throw new Error('アカウントが変わりました。元の端末データは保持しています。');
  }
  fenceNetwork() { this.networkFenced = true; }
  resumeNetwork(identity: LocalAccountIdentity | null) { this.assertCurrent(identity); this.networkFenced = false; }
  invalidate() { this.invalidated = true; }
}

let activeSession: AccountStorageSession | null = null;
/** One JS realm has one owner. Account changes must fence it and reload, never retarget pending async writes. */
export function activateAccountStorage(session: AccountStorageSession) {
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
export const accountLocalStorage: Storage = {
  get length() { return (activeSession?.storage ?? globalThis.localStorage).length; },
  key(index) { return (activeSession?.storage ?? globalThis.localStorage).key(index); },
  getItem(key) { return (activeSession?.storage ?? globalThis.localStorage).getItem(key); },
  setItem(key, value) { (activeSession?.storage ?? globalThis.localStorage).setItem(key, value); },
  removeItem(key) { (activeSession?.storage ?? globalThis.localStorage).removeItem(key); },
  clear() { (activeSession?.storage ?? globalThis.localStorage).clear(); },
};
