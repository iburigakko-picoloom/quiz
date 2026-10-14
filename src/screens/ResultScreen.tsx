import type { QuizResult } from '../types';
import { Layout } from '../components/Layout';
import { ProblemSetIcon } from '../components/UiIcons';
import { StudyCompanion } from '../components/StudyCompanion';
import { COMPANION_BALANCE, companionSessionFood, type CompanionCare } from '../utils/companionCare';
import './ResultScreen.css';

export function ResultScreen({ result, returnLabel, onReturn, onRetry, onRetryWrong, onOpenAnswers, companionCare, companionEnabled = true, companionError, onRetryReward, onOpenCompanion, groupReflectionError, onRetryGroupReflection }: {
  result: QuizResult; returnLabel: string; onReturn: () => void; onRetry: () => void;
  onRetryWrong: () => void; onOpenAnswers: () => void;
  companionCare: CompanionCare | null; companionError: string; onRetryReward: () => Promise<void>; onOpenCompanion: () => void;
  companionEnabled?: boolean;
  groupReflectionError?: string; onRetryGroupReflection?: () => Promise<void>;
}) {
  const rate = result.answered ? Math.round(result.correct / result.answered * 100) : 0;
  const relearned = result.sessionAnswers?.filter((answer) => answer.relearned).length ?? 0;
  const canRetryWrong = result.wrong > 0 && Boolean(result.sessionAnswers?.length);
  const returnText = result.setId ? 'セット詳細へ' : returnLabel;
  const answerIds = (result.sessionAnswers ?? []).flatMap(answer => answer.answerLogId ? [answer.answerLogId] : []);
  const credited = new Set(companionCare?.creditedAnswerIds);
  const rewardReady = Boolean(companionCare) && answerIds.every(id => credited.has(id));
  const foodEarned = companionCare ? companionSessionFood(companionCare, answerIds) : 0;
  return <Layout><main className="library-page qm-result">
    <header className="library-page__header"><h1>学習結果</h1><button onClick={onReturn} aria-label="閉じる">×</button></header>
    <p className="qm-result-title">{result.title}</p>
    <div className="qm-result-score"><strong>{result.correct} / {result.answered}</strong><span>正解</span></div>
    <div className="qm-result-progress" aria-label={`正答率 ${rate}%`}><span style={{width: `${rate}%`}} /></div>
    <div className="qm-result-stats"><div className="qm-correct"><strong>{result.correct}</strong><span>正解</span></div><div className="qm-wrong"><strong>{result.wrong}</strong><span>不正解</span></div><div><strong>{rate}%</strong><span>正答率</span></div></div>
    {relearned ? <p className="qm-banner">{relearned}問を覚え直しました</p> : null}
    {groupReflectionError && <div className="qm-banner" role="status"><p>{groupReflectionError}</p><button type="button" onClick={() => void onRetryGroupReflection?.()}>グループの進捗を再反映</button></div>}
    {companionEnabled && answerIds.length > 0 && <div className="companion-reward" role="status" aria-live="polite">
      {companionError ? <><p>{companionError}</p><button type="button" onClick={() => void onRetryReward()}>ごはんの獲得を再確認</button></>
        : !rewardReady ? <p>ごはんを集計中…</p> : <><span className="companion-reward__icon" aria-hidden="true">◡</span><p><strong>{foodEarned ? `ごはんを${foodEarned}個獲得！` : '次のごはんへ、一歩前進'}</strong><small>{foodEarned ? '自動で受け取りました。' : '今回の回答も積み重ねています。'} あと{COMPANION_BALANCE.answersPerFood - companionCare!.answerRemainder}問で次の1個</small></p><button type="button" onClick={onOpenCompanion}>お世話へ ›</button></>}
    </div>}
    <StudyCompanion scene="result" answered={result.answered} correct={result.correct} care={companionCare} />
    <button className="qm-primary" onClick={canRetryWrong ? onRetryWrong : onReturn}>{canRetryWrong ? `間違えた${result.wrong}問を解く` : returnText}</button>
    <button className="qm-secondary" onClick={canRetryWrong ? onReturn : onRetry}>{canRetryWrong ? returnText : 'もう一度解く'}</button>
    {result.sessionAnswers?.length ? <button className="library-row" onClick={onOpenAnswers}><span className="library-icon"><ProblemSetIcon size={18} /></span><span className="library-row__body"><strong>今回の問題と解答</strong></span><span aria-hidden="true">›</span></button> : null}
  </main></Layout>;
}
