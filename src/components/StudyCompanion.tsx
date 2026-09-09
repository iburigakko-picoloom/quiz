import { useEffect, useState } from 'react';
import { companionPraise, isStudyCompanionEnabled, STUDY_COMPANION_EVENT } from '../utils/studyCompanion';
import './StudyCompanion.css';
import helloImage from '../assets/companion/hello.webp';
import praiseImage from '../assets/companion/praise.webp';

export function StudyCompanion({ scene, answered = 0, correct = 0 }: { scene: 'home' | 'result'; answered?: number; correct?: number }) {
  const [enabled, setEnabled] = useState(isStudyCompanionEnabled);
  useEffect(() => {
    const refresh = () => setEnabled(isStudyCompanionEnabled());
    window.addEventListener(STUDY_COMPANION_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(STUDY_COMPANION_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  if (!enabled) return null;
  return <aside className={`study-companion study-companion--${scene}`} aria-label="学習応援">
    <p className="study-companion__bubble">{scene === 'home' ? '学習頑張ろう！' : companionPraise(answered, correct)}</p>
    <img src={scene === 'home' ? helloImage : praiseImage} alt="" width={scene === 'home' ? 322 : 329} height={scene === 'home' ? 400 : 320} draggable={false} />
  </aside>;
}
