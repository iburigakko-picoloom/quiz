import type { AppData } from '../types';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { getAnswerIndexes, getProgressLevelLabel } from '../utils/quiz';
import { resolveQuestionDetailedExplanation } from '../utils/questionView';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function QuestionDetailScreen({ data, questionId, onBack, onEdit, onDetail, onNote }: { data: AppData; questionId: string; onBack: () => void; onEdit: () => void; onDetail: (editing: boolean) => void; onNote: (setId: string, category: string) => void }) {
  const question = data.questions.find((item) => item.id === questionId);
  if (!question) return <Layout><main className="library-page"><BackButton onClick={onBack} /><p>問題が見つかりません</p></main></Layout>;
  const answers = getAnswerIndexes(question);
  const detail = resolveQuestionDetailedExplanation(data.questions, question);
  return <Layout><main className="library-page">
    <header className="library-page__header"><BackButton onClick={onBack} /><h1>問題詳細</h1><button aria-label="問題を編集" onClick={onEdit}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z" /></svg></button></header>
    <p>{question.category} · {getProgressLevelLabel(data.progress.find((item) => item.questionId === question.id))}</p>
    <h2>{question.question}</h2>
    <ol className="question-detail-choices">{question.choices.map((choice, index) => <li key={index} className={answers.includes(index) ? 'is-correct' : ''}>{choice}{answers.includes(index) ? <span> ✓ 正解</span> : null}</li>)}</ol>
    <section className="question-detail-markdown"><h2>正解と解説</h2><ReactMarkdown remarkPlugins={[remarkGfm]}>{question.explanation}</ReactMarkdown></section>
    <section className="question-detail-markdown"><h2>詳細解答</h2>{detail ? <button className="qm-detail-preview" onClick={() => onDetail(false)}><span>{detail}</span><span aria-hidden="true">›</span></button> : <button onClick={() => onDetail(true)}>＋ 詳細解答を追加</button>}</section>
    <button className="library-row" onClick={() => onNote(question.setId, question.category || '未分類')}>分類ノートへ <span aria-hidden="true">›</span></button>
  </main></Layout>;
}
