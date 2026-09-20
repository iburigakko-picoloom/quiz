import { useMemo } from 'react';
import type { AppData, QuizSession } from '../types';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { StudyActivity } from '../components/StudyActivity';
import { useStudyRecord } from '../hooks/useStudyRecord';
import { getRecommendedReviewQuestions } from '../utils/studyRecord';
import './StudyRecordScreen.css';

export function StudyRecordScreen({ data, onBack, onStart }: { data: AppData; onBack: () => void; onStart: (session: QuizSession) => void }) {
  const { summary, day } = useStudyRecord(data.answerLogs);
  const recommended = useMemo(() => getRecommendedReviewQuestions(data), [data, day]);
  const count = recommended.questions.length;
  return <Layout><div className="study-record">
    <header className="library-page__header study-record__header">
      <BackButton onClick={onBack} label="ホームへ戻る" /><h1>学習記録</h1>
    </header>
    <main className="study-record__body">
      <section className="study-record__card" aria-labelledby="study-review-title">
        <h2 id="study-review-title">復習するべき問題</h2>
        {count ? <>
          <div className="study-record__recommendation">
            <p className="study-record__muted">今日のおすすめ</p>
            <p className="study-record__recommended-count"><strong>{count}</strong>問</p>
          </div>
          <p className="study-record__breakdown"><span>期限到来 {recommended.dueCount}問</span><span>要確認 {recommended.needsCheckCount}問</span></p>
          <button type="button" className="study-record__start" aria-label={`今日のおすすめ問題を${count}問開始`} onClick={() => onStart({ title: '今日のおすすめ', questions: recommended.questions, mode: 'review', backScreen: { name: 'studyRecord' } })}>{count}問はじめる</button>
        </> : <p className="study-record__muted">今日は復習する問題はありません</p>}
      </section>
      <section className="study-record__card" aria-labelledby="study-today-title">
        <h2 id="study-today-title">今日のがんばり</h2><StudyActivity summary={summary} />
      </section>
      <section className="study-record__card" aria-labelledby="study-month-title">
        <h2 id="study-month-title">{summary.month}月の学習カレンダー</h2>
        <div className="study-record__calendar">
          {'月火水木金土日'.split('').map((label) => <span className="study-record__weekday" key={label}>{label}</span>)}
          {Array.from({ length: summary.monthOffset }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
          {summary.calendar.map((date) => <span key={date.key} className={`study-record__date study-record__date--${date.count === 0 ? 0 : date.count < 10 ? 1 : date.count < 30 ? 2 : date.count < 60 ? 3 : 4}${date.isToday ? ' study-record__date--today' : ''}`} aria-label={`${date.day}日 ${date.count}問${date.isToday ? '、今日' : ''}`} aria-current={date.isToday ? 'date' : undefined}>{date.day}</span>)}
        </div>
        <div className="study-record__legend" aria-label="青色が濃いほど回答数が多い日です"><span>少ない</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`study-record__date--${level}`} aria-hidden="true" />)}<span>多い</span></div>
      </section>
    </main>
  </div></Layout>;
}
