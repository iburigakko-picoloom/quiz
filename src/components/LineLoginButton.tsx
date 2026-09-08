import { useCallback, useEffect, useRef, useState } from 'react';
import { lineLoginAvailable, signInWithLine, linkLineIdentity, getLineLinkStatus, onCloudAuthStateChange } from '../utils/cloudService';
import './LineLoginButton.css';

export function LineLoginButton({ link = false, userId }: { link?: boolean; userId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'checking' | 'linked' | 'unlinked' | 'failed'>('checking');
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    if (!link || !userId || !lineLoginAvailable) return;
    const request = ++revision.current;
    setStatus('checking');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const linked = await Promise.race([
        getLineLinkStatus(userId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 12000); }),
      ]);
      if (request === revision.current) setStatus(linked ? 'linked' : 'unlinked');
    } catch {
      if (request === revision.current) setStatus('failed');
    } finally { clearTimeout(timer); }
  }, [link, userId]);
  useEffect(() => {
    if (!link || !lineLoginAvailable) return;
    void refresh();
    const onReturn = () => { if (document.visibilityState === 'visible') void refresh(); };
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onCloudAuthStateChange(() => {
      // Do not call another Auth API while the auth event holds the session lock.
      clearTimeout(authTimer);
      authTimer = setTimeout(() => void refresh(), 0);
    });
    window.addEventListener('focus', onReturn);
    window.addEventListener('pageshow', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      revision.current++;
      clearTimeout(authTimer);
      unsubscribe();
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('pageshow', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [link, refresh]);
  if (!lineLoginAvailable) return null;
  return <div className="line-link">
    {link ? <div className="line-link__status"><span role="status">{status === 'checking' ? 'LINE：確認中…' : status === 'linked' ? '✓ LINE連携済み' : status === 'unlinked' ? 'LINE：未連携' : 'LINE：確認できませんでした'}</span><button type="button" disabled={status === 'checking' || busy} onClick={() => void refresh()}>再確認</button></div> : null}
    {!link || status === 'unlinked' ? <button type="button" className="line-login-button" disabled={busy} onClick={async () => {
      setBusy(true);
      setError('');
      try {
        if (link) {
          const linked = await linkLineIdentity();
          if (linked) { revision.current++; setStatus('linked'); }
        } else await signInWithLine();
      }
      catch (reason) { setError(link && reason instanceof Error ? reason.message : 'LINEログインを開始できませんでした。もう一度お試しください。'); }
      finally { setBusy(false); }
    }}>{busy ? '接続中…' : link ? 'このアカウントにLINEを連携' : 'LINEでログイン'}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
