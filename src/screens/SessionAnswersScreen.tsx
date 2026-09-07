import type { QuizResult } from '../types';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { getAnswerIndexes } from '../utils/quiz';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function SessionAnswersScreen({ result, onBack }: { result: QuizResult; onBack: () => void }) {
  return <Layout><main className="library-page">
    <header className="library-page__header"><BackButton onClick={onBack} /><h1>今回の問題と解答</h1></header>
    {(result.sessionAnswers ?? []).map((answer, index) => <section key={`${index}-${answer.question.id}`} className="session-answer">
      <p className={answer.correct ? 'qm-correct' : 'qm-wrong'}>{index + 1} · {answer.correct ? '正解' : '不正解'}{answer.relearned ? ' · 覚え直した' : ''}</p>
      <h2>{answer.question.question}</h2>
      <ol className="question-detail-choices">{answer.question.choices.map((choice, i) => <li key={i} className={getAnswerIndexes(answer.question).includes(i) ? 'is-correct' : ''}>{choice}{answer.selectedIndexes.includes(i) ? <small>（あなたの回答）</small> : null}</li>)}</ol>
      {!answer.selectedIndexes.length ? <p>あなたの回答：わからない</p> : null}
      <div className="question-detail-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.question.explanation}</ReactMarkdown></div>
    </section>)}
  </main></Layout>;
}
