import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionCharacter, companionActivityMessage, type CompanionMotion, type CompanionActivity } from '../../src/components/CompanionCharacter';
import { COMPANION_IDLE_CLIPS, companionMotionDuration } from '../../src/utils/companionAnimation';
import type { CompanionAction } from '../../src/utils/companionAnimation';
import { COMPANION_TRICKS } from '../../src/utils/companionCare';
import '../../src/index.css';
import '../../src/ui-spec.css';
import '../../src/final-reference.css';

function Preview() {
  const [motion, setMotion] = useState<CompanionMotion | null>(null);
  const [activity, setActivity] = useState<CompanionActivity>('sit');
  const [awkward, setAwkward] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const trigger = (kind: CompanionAction) => {
    window.clearTimeout(timer.current);
    setMotion({ id: Date.now(), kind, awkward });
    timer.current = window.setTimeout(() => setMotion(null), companionMotionDuration(kind, awkward) + 700);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <main style={{ height: '100dvh', padding: '16px', overflowY: 'auto', color: '#334c70', background: 'white' }}>
    <h1 style={{ fontSize: 18, textAlign: 'center' }}>キャラの動き</h1>
    <div className="animation-preview-stage" style={{ width: 'min(100%, 520px)', margin: 'auto' }}>
      <CompanionCharacter large friendship={0} motion={motion} onActivity={setActivity} />
    </div>
    <p role="status" style={{ textAlign: 'center', fontSize: 13 }}>{companionActivityMessage(activity)}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, margin: '20px auto', maxWidth: 540 }}>
      {COMPANION_TRICKS.map(trick => <button type="button" key={trick.id} onClick={() => trigger(trick.id)} style={{ minHeight: 44, padding: '10px 14px', border: '1px solid #dce5ef', borderRadius: 10 }}>{trick.name}</button>)}
      <button type="button" onClick={() => trigger('pet')}>なでる</button>
      <button type="button" onClick={() => trigger('feed')}>ごはん</button>
      <button type="button" onClick={() => { window.clearTimeout(timer.current); setMotion(null); }}>待機に戻る</button>
    </div>
    <label style={{ display: 'block', textAlign: 'center', fontSize: 13 }}><input type="checkbox" checked={awkward} onChange={event => setAwkward(event.target.checked)} /> 練習中のぎこちない動き</label>
    <p style={{ textAlign: 'center', fontSize: 12, color: '#8896a8' }}>待機中：{COMPANION_IDLE_CLIPS.map(clip => clip.activity).join(' → ')}</p>
  </main>;
}
if (import.meta.env.DEV) createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>);
