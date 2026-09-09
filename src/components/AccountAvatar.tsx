import { useEffect, useState } from 'react';
import { getCloudLineAvatar, onCloudAuthStateChange } from '../utils/cloudService';
import { ProfileIcon } from './UiIcons';
import './AccountAvatar.css';

export function AccountAvatar({ userId }: { userId?: string }) {
  const [picture, setPicture] = useState<{ userId: string; url: string | null } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++revision;
      try {
        const url = await getCloudLineAvatar(userId);
        if (active && request === revision) {
          setPicture({ userId, url });
          setFailedUrl(null);
        }
      } catch { /* Keep the fallback available offline. */ }
    };
    void refresh();
    const onReturn = () => { if (document.visibilityState === 'visible') void refresh(); };
    const unsubscribe = onCloudAuthStateChange(() => {
      // Defer Auth API calls until the auth event releases its session lock.
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 0);
    });
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [userId]);
  const url = picture?.userId === userId ? picture?.url : null;
  return url && url !== failedUrl
    ? <img className="account-avatar" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
    : <ProfileIcon />;
}
