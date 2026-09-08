const KEY = 'quiz-make-line-link-attempt';
const MAX_AGE = 20 * 60 * 1000;

export function lineAuthErrorMessage(code: string): string {
  if (code === 'identity_already_exists') return 'このLINEは別のアカウントに連携されています。自動統合は行いません。';
  if (code === 'access_denied') return 'LINEでの認証が許可されなかったため、連携できませんでした。';
  if (code === 'manual_linking_disabled') return 'LINE連携が認証サービス側で無効になっています。';
  if (code === 'provider_email_needs_verification' || code === 'email_not_confirmed') return '認証サービス側でメールアドレスの確認が必要なため、連携できませんでした。';
  if (code === 'bad_oauth_state' || code === 'flow_state_expired') return '認証の有効期限が切れました。同じブラウザでLINE連携をやり直してください。';
  return 'LINE認証の完了処理でエラーが発生しました。LINE・Supabaseの認証設定を確認する必要があります。';
}

export function beginLineLinkAttempt(userId: string): void {
  sessionStorage.setItem(KEY, JSON.stringify({ userId, startedAt: Date.now() }));
}
export function clearLineLinkAttempt(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* No account data is removed. */ }
}
export function readLineLinkAttempt(): { userId: string; startedAt: number } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (!value || typeof value.userId !== 'string' || typeof value.startedAt !== 'number' || Date.now() - value.startedAt > MAX_AGE || value.startedAt > Date.now()) return null;
    return value;
  } catch { return null; }
}

// Capture before Supabase initializes and consumes the callback URL. Never retain tokens or raw error descriptions.
export const lineLinkReturn = (() => {
  if (typeof window === 'undefined') return null;
  const attempt = readLineLinkAttempt();
  if (!attempt) return null;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const code = hash.get('error_code') || url.searchParams.get('error_code') || hash.get('error') || url.searchParams.get('error');
  return { userId: attempt.userId, error: code ? lineAuthErrorMessage(code) : '' };
})();
