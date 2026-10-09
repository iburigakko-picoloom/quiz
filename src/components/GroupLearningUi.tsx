import type { ReactNode } from 'react';
import { FolderOutlineIcon, GroupIcon, HistoryIcon, ProfileIcon, StudyIcon, DocumentOutlineIcon, ChevronRightIcon } from './UiIcons';
import { levelPercentages, type GroupAccent, type GroupIconName, type LevelCounts } from '../utils/groupLearning';

export function GroupAvatar({ icon = 'group', accent = 'blue' }: { icon?: GroupIconName; accent?: GroupAccent }) {
  const Icon = { group: GroupIcon, book: DocumentOutlineIcon, study: StudyIcon, folder: FolderOutlineIcon }[icon];
  return <span className={`group-avatar group-avatar--${accent}`} aria-hidden="true"><Icon size={32} /></span>;
}

export function MemberAvatar({ name, userId }: { name: string; userId: string }) {
  const hue = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
  return <span className={`member-avatar member-avatar--${hue}`} role="img" aria-label={`${name}のアバター`}><ProfileIcon size={28} /></span>;
}

export function LevelProgress({ levels, compact = false, label = '進捗' }: { levels: LevelCounts; compact?: boolean; label?: string }) {
  const percentages = levelPercentages(levels);
  const total = levels.reduce((sum, n) => sum + n, 0);
  return <div className={`level-progress${compact ? ' level-progress--compact' : ''}`}>
    <div className="level-progress__bar" role="img" aria-label={`${label}、${total}問、${percentages.map((p, i) => `Level${i} ${p}%（${levels[i]}問）`).join('、')}`}>
      {levels.map((count, i) => <span key={i} className={`level-progress__segment level-color-${i}`} style={{ width: total ? `${count / total * 100}%` : '0%' }} />)}
    </div>
    <div className="level-progress__legend">{levels.map((count, i) => <div key={i}>
      <span className="level-progress__label"><i className={`level-color-${i}`} />{compact ? `L${i}` : `Level${i}`}</span>
      <strong>{percentages[i]}%</strong><small>（{count.toLocaleString('ja-JP')}問）</small>
    </div>)}</div>
  </div>;
}

export function SharedFolderCard({ name, creatorName, creatorId, sets, questionCount, updatedAt, importLabel, onOpen, actions, busy, partial = false, expanded }: {
  name: string; creatorName: string; creatorId?: string; sets: { title: string }[]; questionCount: number; updatedAt: string; importLabel: string; onOpen: () => void; actions?: ReactNode; busy?: boolean; partial?: boolean; expanded?: boolean;
}) {
  return <article className="group-folder-card">
    <div className="group-folder-card__top"><button type="button" className="group-folder-card__open" aria-expanded={expanded} disabled={busy} onClick={onOpen}>
      <span className="group-folder-card__icon"><FolderOutlineIcon size={46} /></span>
      <span className="group-folder-card__body"><strong>{name}</strong><span className="group-folder-card__creator"><MemberAvatar name={creatorName} userId={creatorId ?? creatorName} />{creatorName}</span><small>{partial ? '表示中 ' : ''}{sets.length}問題セット · {questionCount.toLocaleString('ja-JP')}問</small></span>
      <ChevronRightIcon size={20} />
    </button>{actions}</div>
    <button type="button" className="group-folder-card__examples" disabled={busy} onClick={onOpen}><span>含まれる<br />問題セット例</span><span className="group-folder-card__chips">{sets.slice(0, 3).map((set, i) => <span key={i}>{set.title}</span>)}{sets.length > 3 ? <span>+{sets.length - 3}</span> : null}{!sets.length ? <small>まだありません</small> : null}</span></button>
    <div className="group-folder-card__meta"><span><HistoryIcon size={16} />最終更新 {displayGroupDate(updatedAt)}</span><span><GroupIcon size={16} />{importLabel}</span></div>
  </article>;
}

export function displayGroupDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ja-JP') : '—';
}

export function GroupEmpty({ children }: { children: ReactNode }) {
  return <p className="group-empty">{children}</p>;
}

export function ImportedMemberProgress({ members }: { members: { userId: string; name: string; levels: LevelCounts | null; status?: string; reflectedAt?: string | null }[] }) {
  return <div className="group-progress-members">{members.map(member => <article className="group-progress-member" key={member.userId}>
    <div className="group-progress-member__name"><MemberAvatar name={member.name} userId={member.userId} /><strong>{member.name}</strong></div>
    <div>{member.levels ? <><LevelProgress levels={member.levels} compact label={`${member.name}の進捗`} />{member.reflectedAt ? <small className="group-reflection-date">最終反映 {displayGroupDate(member.reflectedAt)}</small> : null}</> : <p className="group-muted">{member.status ?? '進捗は未共有です'}</p>}</div>
  </article>)}</div>;
}
