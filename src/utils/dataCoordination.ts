import { accountLocalStorage as localStorage } from './accountStorage';
export type DataDomain = 'app' | 'notes';

const DATA_LOCK_NAME = 'quiz-make-origin-data-v1';
const LOCK_WAIT_TIMEOUT_MS = 20_000;
const EPOCH_KEYS: Record<DataDomain, string> = {
  app: 'quizMake:coord:appEpoch',
  notes: 'quizMake:coord:noteEpoch',
};

const knownEpochs: Partial<Record<DataDomain, string>> = {};
const associatedEpochs = new WeakMap<object, Partial<Record<DataDomain, string>>>();
let fallbackQueue: Promise<void> = Promise.resolve();

export class ExternalDataChangeError extends Error {
  constructor() {
    super('別のタブでデータが更新されたため、古い画面からの保存を中止しました。画面を再読み込みしてからやり直してください。');
    this.name = 'ExternalDataChangeError';
  }
}

export class CrossContextLockUnavailableError extends Error {
  constructor() {
    super('このブラウザでは複数タブ間の安全なデータ読み込みを利用できません。OSまたはブラウザを更新してからやり直してください。');
    this.name = 'CrossContextLockUnavailableError';
  }
}

export class DataLockTimeoutError extends Error {
  constructor() {
    super('別のタブの保存処理を待機しましたが完了しませんでした。ほかのQuizMake画面を閉じて、もう一度お試しください。');
    this.name = 'DataLockTimeoutError';
  }
}

export function associateDataEpochSnapshot<T extends object>(
  value: T,
  domains: readonly DataDomain[],
): T {
  const snapshot: Partial<Record<DataDomain, string>> = {};
  uniqueDomains(domains).forEach((domain) => {
    snapshot[domain] = readEpoch(domain);
  });
  associatedEpochs.set(value, snapshot);
  return value;
}

export function assertDataEpochSnapshotCurrent(
  value: object,
  domains: readonly DataDomain[],
): void {
  const snapshot = associatedEpochs.get(value);
  if (!snapshot) throw new ExternalDataChangeError();
  for (const domain of uniqueDomains(domains)) {
    if (snapshot[domain] === undefined || snapshot[domain] !== readEpoch(domain)) {
      throw new ExternalDataChangeError();
    }
  }
}

export async function withCoordinatedDataMutation<T>(
  domains: readonly DataDomain[],
  operation: () => Promise<T>,
  options: { requireCrossContext?: boolean } = {},
): Promise<T> {
  const targets = uniqueDomains(domains);
  return withOriginDataLock(async () => {
    assertKnownEpochsCurrent(targets);
    targets.forEach(reserveNextEpoch);
    return operation();
  }, options.requireCrossContext ?? false);
}

export async function withCoordinatedDataRead<T>(
  domains: readonly DataDomain[],
  operation: () => Promise<T>,
  options: { requireCrossContext?: boolean } = {},
): Promise<T> {
  const targets = uniqueDomains(domains);
  return withOriginDataLock(async () => {
    assertKnownEpochsCurrent(targets);
    const result = await operation();
    assertKnownEpochsCurrent(targets);
    return result;
  }, options.requireCrossContext ?? false);
}

export async function loadLatestCoordinatedData<T>(
  domains: readonly DataDomain[],
  operation: () => Promise<T>,
): Promise<T> {
  const targets = uniqueDomains(domains);
  return withOriginDataLock(async () => {
    const before = Object.fromEntries(targets.map((domain) => [domain, readEpoch(domain)])) as Partial<Record<DataDomain, string>>;
    const result = await operation();
    for (const domain of targets) {
      const current = readEpoch(domain);
      if (current !== before[domain]) throw new ExternalDataChangeError();
      knownEpochs[domain] = current;
    }
    return result;
  }, false);
}

export function isCrossContextDataLockAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

/** Resets module-local coordination state between isolated persistence tests. */
export function resetDataCoordinationForTests(): void {
  delete knownEpochs.app;
  delete knownEpochs.notes;
  fallbackQueue = Promise.resolve();
}

function assertKnownEpochsCurrent(domains: readonly DataDomain[]): void {
  for (const domain of domains) {
    const known = getKnownEpoch(domain);
    if (readEpoch(domain) !== known) throw new ExternalDataChangeError();
  }
}

function reserveNextEpoch(domain: DataDomain): void {
  const next = createEpochToken();
  try {
    localStorage.setItem(EPOCH_KEYS[domain], next);
  } catch (error) {
    throw Object.assign(new Error('複数タブ間の保存状態を記録できないため、データの変更を中止しました。'), { cause: error });
  }
  if (readEpoch(domain) !== next) throw new ExternalDataChangeError();
  knownEpochs[domain] = next;
}

function getKnownEpoch(domain: DataDomain): string {
  if (knownEpochs[domain] === undefined) knownEpochs[domain] = readEpoch(domain);
  return knownEpochs[domain] as string;
}

function readEpoch(domain: DataDomain): string {
  try {
    return localStorage.getItem(EPOCH_KEYS[domain]) ?? '';
  } catch {
    return '';
  }
}

function createEpochToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function withOriginDataLock<T>(
  operation: () => Promise<T>,
  requireCrossContext: boolean,
): Promise<T> {
  if (isCrossContextDataLockAvailable()) {
    const controller = new AbortController();
    let acquired = false;
    const timeoutId = setTimeout(() => {
      if (!acquired) controller.abort();
    }, LOCK_WAIT_TIMEOUT_MS);
    try {
      return await navigator.locks.request(
        DATA_LOCK_NAME,
        { mode: 'exclusive', signal: controller.signal },
        async () => {
          acquired = true;
          clearTimeout(timeoutId);
          return operation();
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DataLockTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (requireCrossContext && typeof document !== 'undefined') {
    throw new CrossContextLockUnavailableError();
  }

  const result = fallbackQueue.catch(() => undefined).then(operation);
  fallbackQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function uniqueDomains(domains: readonly DataDomain[]): DataDomain[] {
  return Array.from(new Set(domains));
}
