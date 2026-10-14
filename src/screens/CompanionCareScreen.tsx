import { useEffect, useRef, useState } from 'react';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { CompanionCharacter, type CompanionMotion } from '../components/CompanionCharacter';
import { companionMotionDuration } from '../utils/companionAnimation';
import { COMPANION_BALANCE, COMPANION_TRICKS, canTeachCompanionTrick, companionFriendshipLabel, isCompanionTrickLearned,
  type CompanionCare, type CompanionCareAction, type CompanionTrickId } from '../utils/companionCare';
import './CompanionCareScreen.css';

export function CompanionCareScreen({ care, busy, error, onAction, onRetry, onBack }: {
  care: CompanionCare | null; busy: boolean; error: string;
  onAction: (action: CompanionCareAction) => Promise<CompanionCare | null>; onRetry: () => Promise<void>; onBack: () => void;
}) {
  const [tab, setTab] = useState<'feed' | 'pet' | 'tricks'>('feed');
  const [selectedTrick, setSelectedTrick] = useState<CompanionTrickId>('spin');
  const [motion, setMotion] = useState<CompanionMotion | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const timers = useRef<number[]>([]);
  const mounted = useRef(true);
  const performing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; timers.current.forEach(window.clearTimeout); }; }, []);

  const play = (kind: CompanionMotion['kind'], awkward = false, reward = false) => {
    timers.current.forEach(window.clearTimeout);
    const id = Date.now();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = companionMotionDuration(kind, awkward);
    performing.current = true;
    setMotion({ id, kind, awkward });
    timers.current = [];
    if (reward) timers.current.push(window.setTimeout(() => { setMotion({ id: id + 1, kind: 'feed' }); }, reduced ? 180 : duration));
    timers.current.push(window.setTimeout(() => { performing.current = false; setMotion(null); }, reduced ? 850 : duration + (reward ? companionMotionDuration('feed') + 600 : 600)));
  };

  const handleAction = async (action: CompanionCareAction) => {
    if (!care || busy || performing.current) return;
    const next = await onAction(action);
    if (!next || !mounted.current) return;
    if (action.kind === 'rename') { setRenaming(false); return; }
    if (action.kind === 'feed') play('feed');
    if (action.kind === 'pet') play('pet');
    if (action.kind === 'train') {
      const trick = COMPANION_TRICKS.find(trick => trick.id === action.trickId)!;
      const learned = isCompanionTrickLearned(next, trick.id);
      play(trick.id, !learned, true);
    }
  };

  const trick = COMPANION_TRICKS.find(trick => trick.id === selectedTrick)!;
  const learned = care ? isCompanionTrickLearned(care, selectedTrick) : false;
  const unlocked = care ? canTeachCompanionTrick(care, selectedTrick) : false;
  const disabled = busy || Boolean(motion) || !care || Boolean(error);

  return <Layout><main className="companion-care">
    <header className="companion-care__header"><BackButton onClick={onBack} /><h1>お世話</h1><span /></header>
    <section className="companion-care__bond" aria-label="名前となかよし度">
      {renaming ? <form className="companion-care__name-form" onSubmit={event => { event.preventDefault(); void handleAction({ kind: 'rename', name }); }}>
        <input aria-label="キャラの名前" value={name} onChange={event => setName(event.target.value)} maxLength={20} autoFocus />
        <button type="submit" disabled={disabled || !name.trim()}>保存</button><button type="button" onClick={() => setRenaming(false)}>取消</button>
      </form> : <button className="companion-care__name" type="button" aria-label="キャラの名前を変更" disabled={disabled} onClick={() => { setName(care?.name ?? ''); setRenaming(true); }}>{care?.name ?? 'パピィ'}<span aria-hidden="true">✎</span></button>}
      <div className="companion-care__bond-caption"><span>♡ なかよし度 <strong>{care?.friendship ?? 0}</strong><small> / {COMPANION_BALANCE.maxFriendship}</small></span><span>{companionFriendshipLabel(care?.friendship ?? 0)}</span></div>
      <progress value={care?.friendship ?? 0} max={COMPANION_BALANCE.maxFriendship} aria-label="なかよし度" />
    </section>
    <section className="companion-care__stage" aria-label="キャラクター">
      <CompanionCharacter friendship={care?.friendship} motion={motion} large />
    </section>
    {error && <div className="companion-care__error" role="alert"><p>{error}</p><button type="button" onClick={() => void onRetry()} disabled={busy}>もう一度読み込む</button></div>}
    {!care && !error && <p className="companion-care__loading" role="status">お世話の記録を読み込み中…</p>}
    <div className="companion-care__controls">
      <div className="companion-care__tabs" role="tablist" aria-label="お世話の種類">
        {([{ id: 'feed', icon: '◡', label: 'ごはん' }, { id: 'pet', icon: '♡', label: 'なでる' }, { id: 'tricks', icon: '☆', label: '芸' }] as const).map(item => <button key={item.id} id={`care-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`care-panel-${item.id}`} onClick={() => setTab(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
      </div>
      <section className="companion-care__panel" id={`care-panel-${tab}`} role="tabpanel" aria-labelledby={`care-tab-${tab}`}>
        {tab === 'feed' && <>
          <div className="companion-care__panel-heading"><h2>ごはん</h2><span className="companion-care__food-count">のこり <strong>{care?.food ?? 0}</strong> 個</span></div>
          <button type="button" className="companion-care__primary" disabled={disabled || !care?.food} onClick={() => void handleAction({ kind: 'feed' })}>ごはんを1個あげる</button>
          <div className="companion-care__food-progress"><span>次のごはんまで あと <strong>{COMPANION_BALANCE.answersPerFood - (care?.answerRemainder ?? 0)}問</strong></span><progress value={care?.answerRemainder ?? 0} max={COMPANION_BALANCE.answersPerFood} aria-label="次のごはんまでの回答数" /></div>
        </>}
        {tab === 'pet' && <>
          <div className="companion-care__panel-heading"><h2>なでる</h2><span className="companion-care__food-count">ごはん不要</span></div>
          <button type="button" className="companion-care__primary" disabled={disabled} onClick={() => void handleAction({ kind: 'pet' })}>やさしくなでる</button>
          <p className="companion-care__hint">今日のなかよし度アップ あと{Math.max(0, COMPANION_BALANCE.rewardedPetsPerDay - (care?.rewardedPets ?? 0))}回</p>
        </>}
        {tab === 'tricks' && <>
          <div className="companion-care__panel-heading"><h2>芸</h2><span className="companion-care__food-count">ごはん <strong>{care?.food ?? 0}</strong> 個</span></div>
          <div className="companion-care__tricks" aria-label="芸を選ぶ">{COMPANION_TRICKS.map(item => {
            const canTeach = care ? canTeachCompanionTrick(care, item.id) : false;
            const done = care ? isCompanionTrickLearned(care, item.id) : false;
            return <button type="button" key={item.id} aria-pressed={item.id === selectedTrick} onClick={() => setSelectedTrick(item.id)}>
              <span><strong>{item.name}</strong><small>{done ? '習得済み' : canTeach ? `${care?.tricks[item.id] ?? 0} / ${item.practices}回` : `なかよし度 ${item.friendship}で解放`}</small></span>
              <progress value={care?.tricks[item.id] ?? 0} max={item.practices} aria-label={`${item.name}の習得度`} />
            </button>;
          })}</div>
          {learned ? <button type="button" className="companion-care__primary" disabled={disabled} onClick={() => { if (!performing.current) play(selectedTrick); }}>{trick.name}をお願い</button>
            : <button type="button" className="companion-care__primary" disabled={disabled || !unlocked || !care?.food} onClick={() => void handleAction({ kind: 'train', trickId: selectedTrick })}>{unlocked ? `${trick.name}を教える（ごはん1個）` : `なかよし度 ${trick.friendship}で解放`}</button>}
        </>}
      </section>
    </div>
  </main></Layout>;
}
