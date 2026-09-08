import { useState } from 'react';
import { lineLoginAvailable, signInWithLine, linkLineIdentity } from '../utils/cloudService';
import './LineLoginButton.css';

export function LineLoginButton({ link = false, linked = false }: { link?: boolean; linked?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!lineLoginAvailable) return null;
  if (linked) return <p role="status">LINE連携済み</p>;
  return <div>
    <button type="button" className="line-login-button" disabled={busy} onClick={async () => {
      setBusy(true);
      setError('');
      try { if (link) await linkLineIdentity(); else await signInWithLine(); }
      catch (reason) { setError(link && reason instanceof Error ? reason.message : 'LINEログインを開始できませんでした。もう一度お試しください。'); }
      finally { setBusy(false); }
    }}>{busy ? '接続中…' : link ? 'このアカウントにLINEを連携' : 'LINEでログイン'}</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
