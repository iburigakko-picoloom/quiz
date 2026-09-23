import type { StudySummary } from '../utils/studyRecord';
import './StudyActivity.css';

export function StudyActivity({ summary, compact = false }: { summary: StudySummary; compact?: boolean }) {
  const max = Math.max(1, ...summary.days.map((day) => day.count));
  return <div className={`study-activity${compact ? ' study-activity--compact' : ''}`}>
    <div className="study-activity__numbers">
      <span className="study-activity__count"><strong>{summary.todayCount.toLocaleString()}</strong>問</span>
      <span className="study-activity__streak">{summary.streak > 0 ? <><span aria-hidden="true">🔥 </span>{summary.streak}日連続</> : '今日からスタート'}</span>
    </div>
    <div className="study-activity__chart" role="img" aria-label={`直近7日間の回答数。${summary.days.map((day) => `${day.key} ${day.count}問`).join('、')}`}>
      {summary.days.map((day, index) => <div className="study-activity__day" key={day.key} aria-hidden="true">
        {!compact && <span className="study-activity__daily-count">{day.count.toLocaleString()}問</span>}
        <div className="study-activity__track"><span className={day.count ? 'study-activity__bar' : 'study-activity__bar study-activity__bar--empty'} style={{ height: `${Math.max(day.count ? 6 : 2, day.count / max * 100)}%`, animationDelay: `${index * 24}ms` }} /></div>
        <span>{day.label}</span>
      </div>)}
    </div>
  </div>;
}
