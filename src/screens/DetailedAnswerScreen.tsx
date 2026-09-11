import type { Question } from '../types';
import { Layout } from '../components/Layout';
import { WeaknessDetail } from '../components/WeaknessDetail';

export function DetailedAnswerScreen({ question, onBack, onDirtyChange, onSave }: {
  question: Question; editing: boolean; onBack: () => void; onEdit: () => void;
  onDirtyChange: (value: boolean) => void; onSave: (body: string, original: Question) => Promise<string | null>;
}) {
  return <Layout><main className="library-page">
    <header className="library-page__header"><button onClick={onBack}>閉じる</button><h1>解説・メモ</h1></header>
    <WeaknessDetail key={question.id} questionId={question.id} text={question.detailedAnswer?.body ?? question.detailedExplanation ?? ''} onDirtyChange={onDirtyChange} onSave={async body => { const error = await onSave(body, question); if (error) throw new Error(error); }} />
  </main></Layout>;
}
