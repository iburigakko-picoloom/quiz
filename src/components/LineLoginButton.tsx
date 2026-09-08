import { useState } from 'react';
import { lineLoginAvailable, signInWithLine } from '../utils/cloudService';
import './LineLoginButton.css';

export function LineLoginButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!lineLoginAvailable) return null;
  return <div>
    <button type="button" className="line-login-button" disabled={busy} onClick={async () => {
      setBusy(true);
      setError('');
      try { await signInWithLine(); }
      catch { setError('LINEログインを開始できませんでした。もう一度お試しください。'); }
      finally { setBusy(false); }
    }}>{busy ? '接続中…' : 'LINEでログイン'}</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
