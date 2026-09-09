import type { User } from '@supabase/supabase-js';

// Profile metadata is used for display only, never authorization.
export function getLineAvatarUrl(user: Pick<User, 'identities'>, provider: string): string | null {
  const profile = user.identities?.find((identity) => identity.provider === provider)?.identity_data;
  for (const value of [profile?.picture, profile?.avatar_url]) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* Missing or invalid pictures use the default icon. */ }
  }
  return null;
}
