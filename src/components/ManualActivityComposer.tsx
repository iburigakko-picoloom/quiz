import { useEffect, useRef, useState } from 'react';
import { useAccountWork, useRestoredAccountWork } from '../hooks/useAccountWork';
import { isAccountWorkReloadApproved } from '../utils/accountWork';
import { getCachedCloudAccountIdentity } from '../utils/cloudService';
import { queueManualActivity } from '../utils/groupManualActivityService';
import type { ManualActivity } from '../utils/groupManualActivityOutbox';
import { PublicDialog } from './PublicDialog';

type Work = { title: string; answered: string; minutes: string; preview: boolean; event: ManualActivity | null };
export function ManualActivityComposer({ groupId, groupName, userId, generation, onClose, onCompleted }: { groupId: string; groupName: string; userId: string; generation: string; onClose: () => void; onCompleted: (status: 'pending' | 'rejected' | 'sent') => void }) {
  const workKey = `group-manual-activity:${groupId}:${userId}`;
  const restored = useRestoredAccountWork<Work>(workKey);
  const [title, setTitle] = useState(restored?.title ?? '');
  const [answered, setAnswered] = useState(restored?.answered ?? '');
  const [minutes, setMinutes] = useState(restored?.minutes ?? '');
  const [preview, setPreview] = useState(restored?.preview ?? false);
  const [event, setEvent] = useState<ManualActivity | null>(restored?.event ?? null);
  const eventRef = useRef(event); eventRef.current = event;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [, forceCloseGuard] = useState(0);
  useAccountWork(workKey, () => ({ title, answered, minutes, preview, event: eventRef.current }), async () => { if (busyRef.current) throw new Error('活動の保存完了を待っています。'); });
  useEffect(() => {
    if (!title && !answered && !minutes && !event) return;
    const protect = (e: BeforeUnloadEvent) => { if (!isAccountWorkReloadApproved()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [title, answered, minutes, event]);
  const close = () => {
    if (busyRef.current) { forceCloseGuard(n => n + 1); return; }
    if ((title || answered || minutes || event) && !window.confirm(event ? '入力を閉じますか？ 送信待ちの記録は残ります。' : '入力を破棄しますか？')) { forceCloseGuard(n => n + 1); return; }
    onClose();
  };
  const validate = () => {
    const count = answered.trim(), time = minutes.trim(), cleanTitle = title.trim();
    if (!cleanTitle || [...cleanTitle].length > 80) return '学習した内容を80文字以内で入力してください。';
    if (count && (!/^\d+$/.test(count) || Number(count) > 2000)) return '問題数は0〜2000の整数で入力してください。';
    if (!/^\d+$/.test(time) || Number(time) < 1 || Number(time) > 1440) return '時間は1〜1440分で入力してください。';
    return '';
  };
  const submit = async () => {
    if (busyRef.current) return;
    const issue = validate(); if (issue) { setError(issue); return; }
    const identity = getCachedCloudAccountIdentity();
    if (!identity || identity.userId !== userId) { setError('アカウントが変更されています。'); return; }
    const row = eventRef.current ?? { id: crypto.randomUUID(), groupId, generation, title: title.trim(), answered: answered.trim() ? Number(answered) : null, minutes: Number(minutes), finishedAt: new Date().toISOString() };
    eventRef.current = row; setEvent(row); busyRef.current = true; setBusy(true); setError('');
    try { const status = await queueManualActivity(identity, row); onCompleted(status); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '活動を保存できません。もう一度お試しください。'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <PublicDialog title="フォルダ外の学習を記録" className="group-manual-dialog" onClose={close}>
    {preview ? <div className="public-form"><p>{groupName}に、あなたの名前と入力内容を共有します。</p><p>{title.trim()}<br/>{answered.trim() ? `${Number(answered)}問・` : ''}{Number(minutes)}分</p><button type="button" className="group-primary" disabled={busy} onClick={() => void submit()}>グループに共有して記録</button>{!event ? <button type="button" className="group-secondary" onClick={() => setPreview(false)}>修正する</button> : null}</div>
    : <form className="public-form" onSubmit={e => { e.preventDefault(); const issue=validate(); if (issue) setError(issue); else { setError(''); setPreview(true); } }}>
      <label>学習した内容<input value={title} maxLength={160} onChange={e => setTitle(e.target.value)} /></label>
      <div className="group-manual__numbers"><label>問題数（任意）<input type="number" inputMode="numeric" min="0" max="2000" value={answered} onChange={e => setAnswered(e.target.value)} /></label>
      <label>時間（分）<input type="number" inputMode="numeric" min="1" max="1440" value={minutes} onChange={e => setMinutes(e.target.value)} /></label></div>
      <button type="submit" className="group-primary">確認する</button>
    </form>}
    {error ? <p role="alert" className="group-error">{error}</p> : null}
  </PublicDialog>;
}
