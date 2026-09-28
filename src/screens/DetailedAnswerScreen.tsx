import type { Question } from '../types';
import { Layout } from '../components/Layout';
import { WeaknessDetail } from '../components/WeaknessDetail';

export function DetailedAnswerScreen({ question, onBack, onDirtyChange, onSave, onAddImage, onRemoveImage }: {
  question: Question; editing: boolean; onBack: () => void; onEdit: () => void;
  onDirtyChange: (value: boolean) => void; onSave: (body: string, original: Question) => Promise<string | null>;
  onAddImage: (questionId: string, file: File) => Promise<void>;
  onRemoveImage: (questionId: string, imageId: string) => Promise<void>;
}) {
  return <Layout><main className="library-page">
    <header className="library-page__header"><button onClick={onBack}>閉じる</button><h1>解説・メモ</h1></header>
    <WeaknessDetail key={question.id} questionId={question.id} text={question.detailedAnswer?.body ?? question.detailedExplanation ?? ''} imageIds={question.detailedAnswer?.imageIds ?? []} onAddImage={file => onAddImage(question.id, file)} onRemoveImage={imageId => onRemoveImage(question.id, imageId)} onDirtyChange={onDirtyChange} onSave={async body => { const error = await onSave(body, question); if (error) throw new Error(error); }} />
  </main></Layout>;
}
