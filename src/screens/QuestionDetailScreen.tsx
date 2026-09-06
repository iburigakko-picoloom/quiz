import type { AppData } from '../types';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { getAnswerIndexes, getProgressLevelLabel } from '../utils/quiz';
import { resolveQuestionDetailedExplanation } from '../utils/questionView';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function QuestionDetailScreen({ data, questionId, onBack, onEdit }: { data: AppData; questionId: string; onBack: () => void; onEdit: (setId: string) => void }) {
  const question = data.questions.find((item) => item.id === questionId);
  if (!question) return <Layout><main className="library-page"><BackButton onClick={onBack} /><p>問題が見つかりません</p></main></Layout>;
  const answers = getAnswerIndexes(question);
  const detail = resolveQuestionDetailedExplanation(data.questions, question);
  return <Layout><main className="library-page">
    <header className="library-page__header"><BackButton onClick={onBack} /><h1>問題詳細</h1><button onClick={() => onEdit(question.setId)}>編集</button></header>
    <p>{question.category} · {getProgressLevelLabel(data.progress.find((item) => item.questionId === question.id))}</p>
    <h2>{question.question}</h2>
    <ol className="question-detail-choices">{question.choices.map((choice, index) => <li key={index} className={answers.includes(index) ? 'is-correct' : ''}>{choice}{answers.includes(index) ? <span> ✓ 正解</span> : null}</li>)}</ol>
    <section className="question-detail-markdown"><h2>正解と解説</h2><ReactMarkdown remarkPlugins={[remarkGfm]}>{question.explanation}</ReactMarkdown></section>
    <section className="question-detail-markdown"><h2>詳細解答</h2>{detail ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail}</ReactMarkdown> : <p>詳細解答は未登録です</p>}</section>
  </main></Layout>;
}
