import type { User } from '@supabase/supabase-js';
import { getLineAvatarUrl } from './lineAvatar';
export const ACCOUNT_PROFILE_EVENT = 'quiz-make-account-profile-change';
const name = (value: unknown) => typeof value === 'string' ? Array.from(value.trim()).slice(0, 40).join('') : '';
/** Display metadata only. Never use these values for authorization. Existing
 * saved settings always win; LINE adoption requires an explicit settings save. */
export function resolveAccountProfile(user: Pick<User, 'id' | 'email' | 'identities'>, storedName: unknown, provider: string) {
  const identity = user.identities?.find(identity => identity.provider === provider)?.identity_data;
  const lineName = name(identity?.name) || name(identity?.display_name) || name(identity?.full_name);
  const savedName = name(storedName);
  return { userId: user.id, displayName: savedName || lineName || name(user.email?.split('@')[0]) || 'Quiz Make ユーザー',
    lineName, avatarUrl: getLineAvatarUrl(user, provider), source: savedName ? 'saved' as const : lineName ? 'line' as const : 'fallback' as const };
}
