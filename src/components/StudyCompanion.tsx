import { useEffect, useState } from 'react';
import { companionGreeting, companionPraise, isStudyCompanionEnabled, STUDY_COMPANION_EVENT } from '../utils/studyCompanion';
import './StudyCompanion.css';
import helloImage from '../assets/companion/hello.webp';
import praiseImage from '../assets/companion/praise.webp';
import tiltImage from '../assets/companion/tilt.webp';
import sitImage from '../assets/companion/sit.webp';
import lookImage from '../assets/companion/look.webp';
import standImage from '../assets/companion/stand.webp';
import turnImage from '../assets/companion/turn.webp';
import restImage from '../assets/companion/rest.webp';

const poses = [helloImage, praiseImage, tiltImage, sitImage, lookImage, standImage, turnImage, restImage];

export function StudyCompanion({ scene, answered = 0, correct = 0 }: { scene: 'home' | 'result'; answered?: number; correct?: number }) {
  const [enabled, setEnabled] = useState(isStudyCompanionEnabled);
  const [pose] = useState(() => poses[Math.floor(Math.random() * poses.length)]);
  const [messageVariant] = useState(() => Math.random());
  useEffect(() => {
    const refresh = () => setEnabled(isStudyCompanionEnabled());
    window.addEventListener(STUDY_COMPANION_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(STUDY_COMPANION_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  if (!enabled) return null;
  return <aside className={`study-companion study-companion--${scene}`} aria-label="学習応援">
    <p className="study-companion__bubble">{scene === 'home' ? companionGreeting(messageVariant) : companionPraise(answered, correct, messageVariant)}</p>
    <img src={pose} alt="" draggable={false} />
  </aside>;
}
