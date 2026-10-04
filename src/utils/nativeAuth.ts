import type { SyncScreenPage } from '../types';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import type { SupabaseClient } from '@supabase/supabase-js';

export const NATIVE_AUTH_SCHEME = 'io.github.manatocookietwitterlang.quizmake.auth';
export const NATIVE_AUTH_CALLBACK_HOST = 'login-callback';
export const NATIVE_AUTH_REDIRECT_URL = `${NATIVE_AUTH_SCHEME}://${NATIVE_AUTH_CALLBACK_HOST}/`;

const AUTH_RETURN_TARGET_KEY = 'quizMake:nativeAuth:returnTarget:v1';
const AUTH_RETURN_TARGET_TTL_MS = 30 * 60 * 1_000;
const MAX_CALLBACK_URL_LENGTH = 16_384;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/iu;
const SAFE_SHARE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,255}$/iu;
const AUTH_CODE_PATTERN = /^[a-z0-9._~-]{8,2048}$/iu;
const FLOW_ID_PATTERN = /^[a-z0-9_-]{8,64}$/iu;

type PersistentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type NativeAuthReturnTarget =
  | { name: 'settings' }
  | { name: 'sync'; page?: SyncScreenPage }
  | {
      name: 'community';
      tab: 'mine' | 'groups' | 'discover';
      groupId?: string;
      shareSetId?: string;
      shareToken?: string;
    };

interface StoredAuthReturnTarget {
  version: 1;
  expiresAt: number;
  target: NativeAuthReturnTarget;
}

export type NativeAuthResultEvent =
  | {
      type: 'signed-in';
      message: string;
      returnTarget: NativeAuthReturnTarget | null;
      userId: string;
    }
  | {
      type: 'error';
      code: NativeAuthErrorCode;
      message: string;
    };

export type NativeAuthErrorCode =
  | 'invalid-callback'
  | 'expired-link'
  | 'missing-verifier'
  | 'network'
  | 'sign-in-failed'
  | 'listener-failed';

export type ParsedNativeAuthCallback =
  | { kind: 'not-auth-callback' }
  | { kind: 'error'; code: NativeAuthErrorCode }
  | { kind: 'pkce'; code: string; flowId?: string };

type NativeAuthResultListener = (event: NativeAuthResultEvent) => void;

const resultListeners = new Set<NativeAuthResultListener>();
let inMemoryReturnTarget: StoredAuthReturnTarget | null = null;
let callbackState: 'idle' | 'processing' | 'handled' = 'idle';
let listenerHandle: PluginListenerHandle | null = null;
let listenerStartPromise: Promise<void> | null = null;
let listenerReferenceCount = 0;
let listenerClient: SupabaseClient | null = null;

export function isNativeAuthPlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function getCloudAuthRedirectUrl(): string {
  if (isNativeAuthPlatform()) return NATIVE_AUTH_REDIRECT_URL;
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

export function rememberNativeAuthReturnTarget(
  target: NativeAuthReturnTarget,
  storage: PersistentStorage | null = getPersistentStorage(),
  now = Date.now(),
): boolean {
  const normalizedTarget = normalizeReturnTarget(target);
  if (!normalizedTarget) {
    clearNativeAuthReturnTarget(storage);
    return false;
  }

  const record: StoredAuthReturnTarget = {
    version: 1,
    expiresAt: now + AUTH_RETURN_TARGET_TTL_MS,
    target: normalizedTarget,
  };
  inMemoryReturnTarget = record;

  if (!storage) return false;
  try {
    storage.setItem(AUTH_RETURN_TARGET_KEY, JSON.stringify(record));
    return true;
  } catch {
    try {
      storage.removeItem(AUTH_RETURN_TARGET_KEY);
    } catch {
      // Keep the current target in memory for this process only.
    }
    return false;
  }
}

export function consumeNativeAuthReturnTarget(
  storage: PersistentStorage | null = getPersistentStorage(),
  now = Date.now(),
): NativeAuthReturnTarget | null {
  const memoryRecord = inMemoryReturnTarget;
  inMemoryReturnTarget = null;

  let storedRecord: StoredAuthReturnTarget | null = null;
  if (storage) {
    try {
      const raw = storage.getItem(AUTH_RETURN_TARGET_KEY);
      storage.removeItem(AUTH_RETURN_TARGET_KEY);
      storedRecord = raw ? parseStoredReturnTarget(raw) : null;
    } catch {
      // The in-memory copy still preserves same-process navigation.
    }
  }

  const record = storedRecord ?? memoryRecord;
  if (!record || record.expiresAt <= now || record.expiresAt > now + AUTH_RETURN_TARGET_TTL_MS) return null;
  return normalizeReturnTarget(record.target);
}

export function clearNativeAuthReturnTarget(storage: PersistentStorage | null = getPersistentStorage()): void {
  inMemoryReturnTarget = null;
  if (!storage) return;
  try {
    storage.removeItem(AUTH_RETURN_TARGET_KEY);
  } catch {
    // Best-effort cleanup only. Expiry still prevents stale restoration.
  }
}

export function beginNativeAuthAttempt(returnTarget?: NativeAuthReturnTarget): void {
  callbackState = 'idle';
  if (returnTarget) rememberNativeAuthReturnTarget(returnTarget);
  else clearNativeAuthReturnTarget();
}

export function onNativeAuthResult(listener: NativeAuthResultListener): () => void {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
}

export function parseNativeAuthCallback(rawUrl: string): ParsedNativeAuthCallback {
  if (!rawUrl || rawUrl.length > MAX_CALLBACK_URL_LENGTH) return { kind: 'not-auth-callback' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'not-auth-callback' };
  }

  if (
    url.protocol !== `${NATIVE_AUTH_SCHEME}:`
    || url.hostname !== NATIVE_AUTH_CALLBACK_HOST
    || (url.pathname !== '' && url.pathname !== '/')
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
  ) {
    return { kind: 'not-auth-callback' };
  }

  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const errorCode = firstSingleValue(url.searchParams, fragment, 'error_code')
    ?? firstSingleValue(url.searchParams, fragment, 'error');
  if (errorCode) return { kind: 'error', code: mapCallbackErrorCode(errorCode) };

  const codes = valuesAcross(url.searchParams, fragment, 'code');
  const flowIds = valuesAcross(url.searchParams, fragment, 'sb_flow_id');
  if (
    codes.length !== 1
    || !AUTH_CODE_PATTERN.test(codes[0])
    || flowIds.length > 1
    || (flowIds.length === 1 && !FLOW_ID_PATTERN.test(flowIds[0]))
  ) {
    return { kind: 'error', code: 'invalid-callback' };
  }

  return {
    kind: 'pkce',
    code: codes[0],
    ...(flowIds[0] ? { flowId: flowIds[0] } : {}),
  };
}

export async function handleNativeAuthUrl(client: SupabaseClient, rawUrl: string): Promise<boolean> {
  const callback = parseNativeAuthCallback(rawUrl);
  if (callback.kind === 'not-auth-callback') return false;
  if (callbackState !== 'idle') return true;
  callbackState = 'processing';

  if (callback.kind === 'error') {
    callbackState = 'handled';
    emitResult(errorEvent(callback.code));
    return true;
  }

  try {
    const { data, error } = await client.auth.exchangeCodeForSession(
      callback.code,
      callback.flowId ? { flowId: callback.flowId } : undefined,
    );
    if (error || !data.session || !data.user || data.user.is_anonymous) {
      callbackState = 'handled';
      emitResult(errorEvent(mapExchangeError(error?.message ?? '')));
      return true;
    }

    callbackState = 'handled';
    emitResult({
      type: 'signed-in',
      message: 'ログインしました。',
      returnTarget: consumeNativeAuthReturnTarget(),
      userId: data.user.id,
    });
    return true;
  } catch (reason) {
    callbackState = 'handled';
    emitResult(errorEvent(mapExchangeError(reason instanceof Error ? reason.message : '')));
    return true;
  }
}

export async function startNativeAuthListener(client: SupabaseClient): Promise<() => Promise<void>> {
  if (!isNativeAuthPlatform()) return async () => undefined;
  if (listenerClient && listenerClient !== client) throw new Error('Native auth listener is already using another client.');

  listenerClient = client;
  listenerReferenceCount += 1;
  if (!listenerStartPromise) {
    listenerStartPromise = (async () => {
      try {
        listenerHandle = await CapacitorApp.addListener('appUrlOpen', ({ url }) => {
          void handleNativeAuthUrl(client, url);
        });
        const launch = await CapacitorApp.getLaunchUrl();
        if (launch?.url) await handleNativeAuthUrl(client, launch.url);
      } catch {
        emitResult(errorEvent('listener-failed'));
      }
    })();
  }
  await listenerStartPromise;

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    listenerReferenceCount = Math.max(0, listenerReferenceCount - 1);
    if (listenerReferenceCount !== 0) return;
    const handle = listenerHandle;
    listenerHandle = null;
    listenerStartPromise = null;
    listenerClient = null;
    await handle?.remove();
  };
}

function getPersistentStorage(): PersistentStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeReturnTarget(value: unknown): NativeAuthReturnTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Record<string, unknown>;
  if (target.name === 'settings') return { name: 'settings' };
  if (target.name === 'sync') {
    if (target.page === undefined) return { name: 'sync' };
    if (target.page === 'settings' || target.page === 'recovery' || target.page === 'connect' || target.page === 'diagnostics' || target.page === 'danger') return { name: 'sync', page: target.page };
    return null;
  }
  if (target.name !== 'community') return null;
  if (target.tab !== 'mine' && target.tab !== 'groups' && target.tab !== 'discover') return null;

  const shareSetId = typeof target.shareSetId === 'string' && SAFE_ID_PATTERN.test(target.shareSetId)
    ? target.shareSetId
    : undefined;
  const groupId = typeof target.groupId === 'string' && SAFE_ID_PATTERN.test(target.groupId)
    ? target.groupId
    : undefined;
  const shareToken = typeof target.shareToken === 'string' && SAFE_SHARE_TOKEN_PATTERN.test(target.shareToken)
    ? target.shareToken
    : undefined;
  if (target.shareSetId !== undefined && !shareSetId) return null;
  if (target.groupId !== undefined && !groupId) return null;
  if (target.shareToken !== undefined && !shareToken) return null;

  return {
    name: 'community',
    tab: target.tab,
    ...(groupId ? { groupId } : {}),
    ...(shareSetId ? { shareSetId } : {}),
    ...(shareToken ? { shareToken } : {}),
  };
}

function parseStoredReturnTarget(raw: string): StoredAuthReturnTarget | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredAuthReturnTarget>;
    const target = normalizeReturnTarget(value.target);
    if (value.version !== 1 || !Number.isFinite(value.expiresAt) || !target) return null;
    return { version: 1, expiresAt: Number(value.expiresAt), target };
  } catch {
    return null;
  }
}

function valuesAcross(search: URLSearchParams, fragment: URLSearchParams, key: string): string[] {
  return [...search.getAll(key), ...fragment.getAll(key)];
}

function firstSingleValue(search: URLSearchParams, fragment: URLSearchParams, key: string): string | null {
  const values = valuesAcross(search, fragment, key);
  return values.length === 1 ? values[0] : null;
}

function mapCallbackErrorCode(code: string): NativeAuthErrorCode {
  const normalized = code.toLowerCase();
  if (normalized.includes('expired') || normalized.includes('otp')) return 'expired-link';
  return 'sign-in-failed';
}

function mapExchangeError(message: string): NativeAuthErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes('failed to fetch') || normalized.includes('network')) return 'network';
  if (normalized.includes('code verifier') || normalized.includes('pkce')) return 'missing-verifier';
  if (normalized.includes('expired') || normalized.includes('invalid grant') || normalized.includes('already been used')) {
    return 'expired-link';
  }
  return 'sign-in-failed';
}

function errorEvent(code: Extract<NativeAuthResultEvent, { type: 'error' }>['code']): NativeAuthResultEvent {
  const messages: Record<typeof code, string> = {
    'invalid-callback': 'ログインリンクを確認できませんでした。ログイン画面から新しいリンクを送ってください。',
    'expired-link': 'ログインリンクの有効期限が切れているか、すでに使用されています。新しいリンクを送ってください。',
    'missing-verifier': 'リンクを送った同じ端末でログインを完了してください。解決しない場合は新しいリンクを送ってください。',
    network: 'ログインを確認できませんでした。通信状態を確認して、もう一度お試しください。',
    'sign-in-failed': 'ログインを完了できませんでした。ログイン画面からもう一度お試しください。',
    'listener-failed': 'ログインリンクを受け取れませんでした。アプリを開き直して、もう一度お試しください。',
  };
  return { type: 'error', code, message: messages[code] };
}

function emitResult(event: NativeAuthResultEvent): void {
  resultListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // A UI subscriber must not prevent session completion or other subscribers.
    }
  });
}
