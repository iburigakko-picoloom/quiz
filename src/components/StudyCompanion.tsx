import { useEffect, useState, type ReactNode } from 'react';
import { companionGreeting, companionPraise, isStudyCompanionEnabled, STUDY_COMPANION_EVENT } from '../utils/studyCompanion';
import './StudyCompanion.css';
import { CompanionCharacter } from './CompanionCharacter';
import type { CompanionCare } from '../utils/companionCare';

export function StudyCompanion({ scene, answered = 0, correct = 0, children, compact = false, care, onOpenCare }: { scene: 'home' | 'result'; answered?: number; correct?: number; children?: ReactNode; compact?: boolean; care?: CompanionCare | null; onOpenCare?: () => void }) {
  const [enabled, setEnabled] = useState(isStudyCompanionEnabled);
  const [messageVariant] = useState(() => Math.random());
  useEffect(() => {
    const refresh = () => setEnabled(isStudyCompanionEnabled());
    window.addEventListener(STUDY_COMPANION_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(STUDY_COMPANION_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  if (!enabled && !children) return null;
  return <aside className={`study-companion study-companion--${scene}${children ? ' study-companion--summary' : ''}${compact ? ' study-companion--compact' : ''}${!enabled ? ' study-companion--no-dog' : ''}`} aria-label="学習応援">
    {children ?? <p className="study-companion__bubble">{scene === 'home' ? companionGreeting(messageVariant) : companionPraise(answered, correct, messageVariant)}</p>}
    {enabled && (children ? <div className="study-companion__dog">
      {!compact ? <p className="study-companion__bubble">{companionGreeting(messageVariant)}</p> : null}
      {onOpenCare ? <button className="study-companion__open-care" type="button" aria-label={`${care?.name ?? 'パピィ'}のお世話をする`} onClick={onOpenCare}><CompanionCharacter friendship={care?.friendship} /></button>
        : <CompanionCharacter friendship={care?.friendship} />}
    </div> : <CompanionCharacter friendship={care?.friendship} />)}
  </aside>;
}
