import type { QuizResult } from '../types';
import { Layout } from '../components/Layout';
import { ProblemSetIcon } from '../components/UiIcons';
import { StudyCompanion } from '../components/StudyCompanion';

export function ResultScreen({ result, returnLabel, onReturn, onRetry, onRetryWrong, onOpenAnswers }: {
  result: QuizResult; returnLabel: string; onReturn: () => void; onRetry: () => void;
  onRetryWrong: () => void; onOpenAnswers: () => void;
}) {
  const rate = result.answered ? Math.round(result.correct / result.answered * 100) : 0;
  const relearned = result.sessionAnswers?.filter((answer) => answer.relearned).length ?? 0;
  const canRetryWrong = result.wrong > 0 && Boolean(result.sessionAnswers?.length);
  const returnText = result.setId ? 'セット詳細へ' : returnLabel;
  return <Layout><main className="library-page qm-result">
    <header className="library-page__header"><h1>学習結果</h1><button onClick={onReturn} aria-label="閉じる">×</button></header>
    <p className="qm-result-title">{result.title}</p>
    <div className="qm-result-score"><strong>{result.correct} / {result.answered}</strong><span>正解</span></div>
    <div className="qm-result-progress" aria-label={`正答率 ${rate}%`}><span style={{width: `${rate}%`}} /></div>
    <div className="qm-result-stats"><div className="qm-correct"><strong>{result.correct}</strong><span>正解</span></div><div className="qm-wrong"><strong>{result.wrong}</strong><span>不正解</span></div><div><strong>{rate}%</strong><span>正答率</span></div></div>
    {relearned ? <p className="qm-banner">{relearned}問を覚え直しました</p> : null}
    <StudyCompanion scene="result" answered={result.answered} correct={result.correct} />
    <button className="qm-primary" onClick={canRetryWrong ? onRetryWrong : onReturn}>{canRetryWrong ? `間違えた${result.wrong}問を解く` : returnText}</button>
    <button className="qm-secondary" onClick={canRetryWrong ? onReturn : onRetry}>{canRetryWrong ? returnText : 'もう一度解く'}</button>
    {result.sessionAnswers?.length ? <button className="library-row" onClick={onOpenAnswers}><span className="library-icon"><ProblemSetIcon size={18} /></span><span className="library-row__body"><strong>今回の問題と解答</strong></span><span aria-hidden="true">›</span></button> : null}
  </main></Layout>;
}
