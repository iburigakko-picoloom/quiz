import { useEffect, useRef, useState } from 'react';
import { getCloudSession, lineLoginAvailable, onCloudAuthStateChange } from '../utils/cloudService';
import { isNativeAuthPlatform } from '../utils/nativeAuth';
import { LineLoginButton } from './LineLoginButton';
import './WelcomeGuide.css';

const SEEN_KEY = 'quiz-make-welcome-v1';
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const installed = () => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone) || isNativeAuthPlatform();

export function WelcomeGuide({ active }: { active: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(SEEN_KEY) === 'done'; } catch { return true; } });
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [isInstalled, setInstalled] = useState(installed);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const dismiss = () => { try { localStorage.setItem(SEEN_KEY, 'done'); } catch { /* Keep dismissal for this visit. */ } setSeen(true); };
  useEffect(() => {
    let alive = true;
    void getCloudSession().then((session) => { if (alive) setSignedIn(Boolean(session)); }).catch(() => {}).finally(() => { if (alive) setReady(true); });
    const unsubscribe = onCloudAuthStateChange((_, session) => { if (alive) { setSignedIn(Boolean(session)); setReady(true); } });
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    const onInstalled = () => { setInstalled(true); setInstallEvent(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { alive = false; unsubscribe(); window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  const show = active && ready && !seen && !isNativeAuthPlatform() && ((!signedIn && lineLoginAvailable) || !isInstalled);
  useEffect(() => { if (show) { if (!dialog.current?.open) dialog.current?.showModal(); } else dialog.current?.close(); }, [show]);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return <dialog ref={dialog} className="welcome-guide" onCancel={dismiss}>
    <header><h2>Quiz Makeへようこそ</h2><button type="button" aria-label="案内を閉じる" onClick={dismiss}>×</button></header>
    {!signedIn && lineLoginAvailable ? <section><h3>LINEでログイン</h3><p>共有や同期を使う方におすすめです。</p><LineLoginButton /></section> : null}
    {!isInstalled ? <section><h3>ホーム画面に追加</h3><p>アイコンからすぐに開けます。</p><button type="button" className="welcome-guide__install" disabled={installBusy} onClick={async () => {
      if (!installEvent) { setShowSteps(true); return; }
      setInstallBusy(true);
      try { await installEvent.prompt(); const choice = await installEvent.userChoice; if (choice.outcome === 'accepted') setInstalled(true); }
      catch { setShowSteps(true); }
      finally { setInstallEvent(null); setInstallBusy(false); }
    }}>ホーム画面に追加する</button>
      {showSteps ? <p role="status">{ios ? 'Safariの共有メニューから「ホーム画面に追加」を選んでください。' : 'Chromeなどのブラウザのメニューから「ホーム画面に追加」または「アプリをインストール」を選んでください。'}</p> : null}
    </section> : null}
    <button type="button" className="welcome-guide__later" onClick={dismiss}>あとで・このまま使う</button>
  </dialog>;
}
