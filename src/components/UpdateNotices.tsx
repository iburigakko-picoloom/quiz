import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { CLOUD_UPDATE_EVENT, dismissCloudUpdate, isCloudUpdateDismissed, type CloudUpdateNotice } from '../utils/cloudUpdateNotice';
import { getLastSyncState, getStoredSyncId } from '../utils/syncService';
import './UpdateNotices.css';

export function SwipeNotice({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  const [offset, setOffset] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const start = useRef<{ id: number; y: number } | null>(null);
  const callback = useRef(onDismiss);
  callback.current = onDismiss;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => callback.current(), 200);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current?.id !== event.pointerId) return;
    const moved = event.clientY - start.current.y;
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (moved < -32) setLeaving(true);
    else setOffset(0);
  };
  return <div className={`quiz-update-toast swipe-notice${leaving ? ' swipe-notice--leaving' : ''}`} role="status" aria-live="polite"
    style={{ transform: leaving ? undefined : `translateY(${offset}px)`, opacity: leaving ? undefined : Math.max(.3, 1 + offset / 140) }}
    onPointerDown={(event) => {
      if (leaving || !event.isPrimary || event.button !== 0 || (event.target as Element).closest('button')) return;
      start.current = { id: event.pointerId, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => { if (start.current?.id === event.pointerId) setOffset(Math.max(-140, Math.min(0, event.clientY - start.current.y))); }}
    onPointerUp={finish}
    onPointerCancel={() => { start.current = null; setOffset(0); }}>
    {children}<button className="swipe-notice__close" type="button" aria-label="通知を閉じる" onClick={() => setLeaving(true)}>×</button>
  </div>;
}

export function UpdateNotices({ screenKey, updateAvailable, updateMessage, disabled: updateBlocked, onUpdate, onCloudReview }: {
  screenKey: string; updateAvailable: boolean; updateMessage: string; disabled: boolean;
  onUpdate: () => void; onCloudReview: () => void;
}) {
  const [hiddenScreen, setHiddenScreen] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudUpdateNotice | null>(null);
  useEffect(() => { setHiddenScreen(null); }, [screenKey, updateAvailable]);
  useEffect(() => {
    const receive = (event: Event) => {
      const notice = (event as CustomEvent<CloudUpdateNotice>).detail;
      if (notice?.syncId !== getStoredSyncId().trim() || !notice.updatedAt || isCloudUpdateDismissed(notice)) return;
      setCloud(notice);
    };
    const refresh = () => setCloud((current) => current && (current.syncId !== getStoredSyncId().trim() || current.updatedAt === getLastSyncState().lastSyncAt) ? null : current);
    window.addEventListener(CLOUD_UPDATE_EVENT, receive);
    window.addEventListener('quiz-make-sync-state-change', refresh);
    window.addEventListener('quiz-make-sync-settings-change', refresh);
    return () => {
      window.removeEventListener(CLOUD_UPDATE_EVENT, receive);
      window.removeEventListener('quiz-make-sync-state-change', refresh);
      window.removeEventListener('quiz-make-sync-settings-change', refresh);
    };
  }, []);
  return <>
    {cloud && screenKey !== 'sync' && <SwipeNotice key={`${cloud.syncId}:${cloud.updatedAt}`} onDismiss={() => { dismissCloudUpdate(cloud); setCloud(null); }}>
      <span>{updateBlocked ? 'クラウドに更新があります。作業終了後に確認できます' : 'クラウドに更新があります'}</span><button type="button" disabled={updateBlocked} onClick={onCloudReview}>内容を確認</button>
    </SwipeNotice>}
    {updateAvailable && hiddenScreen !== screenKey && <SwipeNotice key={`app-${screenKey}`} onDismiss={() => setHiddenScreen(screenKey)}>
      <span>{updateMessage}</span><button type="button" disabled={updateBlocked} onClick={onUpdate}>更新する</button>
    </SwipeNotice>}
  </>;
}
