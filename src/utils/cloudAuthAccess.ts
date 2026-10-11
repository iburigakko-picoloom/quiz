import type { Session, User } from '@supabase/supabase-js';

export type CloudAccessTokenResult = { ok: true; accessToken: string; userId: string } | {
  ok: false; reason: 'not-configured' | 'signed-out' | 'validation-failed' | 'temporarily-unavailable' | 'account-changed'; message: string; cause?:'session_read'|'user_validation'|'session_recheck'|'token_rotation'|'session_capacity';
};
type AuthReader = {
  getSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
  getUser(jwt: string): Promise<{ data: { user: User | null }; error: unknown }>;
  refreshSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
};
const authCapacity=(error:unknown)=>{if(!error||typeof error!=='object')return false;const value=error as {name?:unknown;originalError?:{name?:unknown}};return ['QuotaExceededError','NS_ERROR_DOM_QUOTA_REACHED'].includes(String(value.name))||['QuotaExceededError','NS_ERROR_DOM_QUOTA_REACHED'].includes(String(value.originalError?.name));};
const unavailable = (cause:Exclude<CloudAccessTokenResult,{ok:true}>['cause']='user_validation',error?:unknown): CloudAccessTokenResult => {if(authCapacity(error))cause='session_capacity';return { ok: false, reason: 'temporarily-unavailable',cause,message:({session_capacity:'ログイン・設定用の保存領域が不足しています。教材データは保持しています。',session_read:'端末のログイン情報を読み出せませんでした。端末データを保持して再試行します。',user_validation:'認証サーバーの応答を確認できませんでした。端末データを保持して再試行します。',session_recheck:'認証確認後のログイン情報を読み直せませんでした。端末データを保持して再試行します。',token_rotation:'確認中にログイン情報が更新されました。端末データを保持して再試行します。'} as const)[cause!] };};
const changed = (): CloudAccessTokenResult => ({ ok: false, reason: 'account-changed', message: 'アカウントまたは端末の所有状態が変わりました。元の端末データは保持しています。' });
function rejected(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: string; status?: number; code?: string };
  if (value.name === 'AuthRetryableFetchError') return false;
  return value.status === 401 || value.status === 403 || ['bad_jwt', 'session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'user_not_found', 'user_banned'].includes(value.code ?? '');
}
const denied = (): CloudAccessTokenResult => ({ ok: false, reason: 'validation-failed', message: 'サーバーでログインの有効性を確認できませんでした。端末データは保持しています。' });
export function cloudAccessFailureCode(reason: Exclude<CloudAccessTokenResult, { ok: true }>['reason'],cause?:Exclude<CloudAccessTokenResult,{ok:true}>['cause']) {
  if(reason==='temporarily-unavailable'&&cause==='token_rotation')return 'authentication_busy';
  if(reason==='temporarily-unavailable'&&cause==='session_capacity')return 'storage_capacity';
  return reason === 'temporarily-unavailable' ? 'network' : reason === 'account-changed' ? 'connection_changed'
    : reason === 'not-configured' ? 'unavailable' : 'authentication_required';
}
export class CloudSessionReadError extends Error { readonly code: string; constructor(error: unknown) { super(authCapacity(error)?'ログイン・設定用の保存領域が不足しています。教材データは保持しています。':'端末のログイン情報を読み出せませんでした。端末データを保持して再試行します。'); this.code = authCapacity(error)?'storage_capacity':rejected(error) ? 'authentication_required' : 'network'; } }

/** A cached session never authorizes a request. Validate the exact JWT, then
 * re-read it: a same-account refresh may have rotated it while Auth was checked. */
export async function verifiedCloudAccess(auth: AuthReader, guard: (userId: string) => void, cachedUserId: () => string | null, now = () => Date.now()): Promise<CloudAccessTokenResult> {
  let expected: string | undefined, refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let current: Awaited<ReturnType<AuthReader['getSession']>>;
    try { current = await auth.getSession(); } catch(error) { return unavailable('session_read',error); }
    if (current.error) return rejected(current.error) ? denied() : unavailable('session_read',current.error);
    const session = current.data.session;
    if (!session?.access_token || session.user.is_anonymous) {
      let cached: string | null; try { cached = cachedUserId(); } catch { return changed(); }
      if (cached && !session?.user.is_anonymous) { expected ??= cached; if (attempt === 0) continue; return unavailable('session_read'); }
      return { ok: false, reason: 'signed-out', message: 'クラウド同期を使うにはログインが必要です。' };
    }
    expected ??= session.user.id;
    if (session.user.id !== expected) return changed();
    try { guard(expected); } catch { return changed(); }
    let verified: Awaited<ReturnType<AuthReader['getUser']>>;
    try { verified = await auth.getUser(session.access_token); } catch(error) { return unavailable('user_validation',error); }
    if (verified.error) {
      if (!rejected(verified.error)) return unavailable('user_validation',verified.error);
      let latest: Awaited<ReturnType<AuthReader['getSession']>>;
      try { latest = await auth.getSession(); } catch(error) { return unavailable('session_recheck',error); }
      if (latest.error) return rejected(latest.error) ? denied() : unavailable('session_recheck',latest.error);
      if (latest.data.session?.user.id !== expected) return changed();
      try { guard(expected); } catch { return changed(); }
      if (latest.data.session.access_token !== session.access_token) continue;
      const failure = verified.error as { status?: number; code?: string };
      const expired = typeof session.expires_at === 'number' && session.expires_at * 1000 <= now()
        && (failure.code === 'bad_jwt' || failure.status === 401 && !['session_not_found', 'session_expired', 'user_not_found'].includes(failure.code ?? ''));
      if (!refreshed && expired) {
        refreshed = true;
        try { const renewed = await auth.refreshSession(); if (renewed.error) return rejected(renewed.error) ? denied() : unavailable('session_recheck',renewed.error); if (renewed.data.session?.user.id !== expected) return changed(); }
        catch(error) { return unavailable('session_recheck',error); }
        continue;
      }
      return denied();
    }
    if (!verified.data.user || verified.data.user.is_anonymous) return denied();
    if (verified.data.user.id !== expected) return changed();
    try { guard(expected); } catch { return changed(); }
    let latest: Awaited<ReturnType<AuthReader['getSession']>>;
    try { latest = await auth.getSession(); } catch(error) { return unavailable('session_recheck',error); }
    if (latest.error) return rejected(latest.error) ? denied() : unavailable('session_recheck',latest.error);
    if (!latest.data.session) { let cached: string | null; try { cached = cachedUserId(); } catch { return changed(); } return cached === expected ? unavailable('session_recheck') : changed(); }
    if (latest.data.session.user.id !== expected || latest.data.session.user.is_anonymous) return changed();
    try { guard(expected); } catch { return changed(); }
    if (latest.data.session.access_token !== session.access_token) continue;
    return { ok: true, accessToken: session.access_token, userId: expected };
  }
  return unavailable('token_rotation');
}

/** UI snapshots only; callbacks stay synchronous and never await the SDK's Auth lock. */
export function watchCloudSession<T extends { user: { id: string } }>(options: { read(): Promise<T | null>; cached(): T | null; subscribe(fn: (event: string, session: T | null) => void): () => void; emit(session: T | null): void }) {
  let stopped = false, revision = 0, previous: T | null = null;
  const cached = () => { try { return options.cached(); } catch { return null; } };
  const initial = cached(); if (initial) { previous = initial; options.emit(initial); }
  const unsubscribe = options.subscribe((event, session) => {
    revision++;
    if (stopped) return;
    const stored = cached();
    if (!session && event !== 'SIGNED_OUT' && stored && (!previous || previous.user.id === stored.user.id)) return;
    previous = session; options.emit(session);
  });
  const initialRevision = revision;
  void options.read().then(session => {
    if (stopped || revision !== initialRevision) return;
    const stored = cached();
    if (!session && stored && (!previous || previous.user.id === stored.user.id)) return;
    previous = session; options.emit(session);
  }).catch(() => { /* Keep a known UI account; failure never authorizes traffic. */ });
  return () => { stopped = true; unsubscribe(); };
}
