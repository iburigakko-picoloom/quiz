import { useState } from 'react';
import type { AppData, MaterialReference, Question } from '../types';
import { Layout } from '../components/Layout';
import { BackButton } from '../components/BackButton';
import { WeaknessDetail } from '../components/WeaknessDetail';
import { MaterialsDrawer } from '../components/MaterialsDrawer';
import { useMaterialsNavigation, type MaterialsExitGuard } from '../hooks/useMaterialsNavigation';
import type { ReferenceLink } from '../utils/referenceLinking';
import { getQuestionsBySet } from '../utils/quiz';

export function DetailedAnswerScreen({ data, question, onBack, onDirtyChange, onSave, onAddImage, onRemoveImage, registerExitGuard, onLinkPage, onLinkBatch }: {
  data: AppData;
  question: Question; editing: boolean; onBack: () => void; onEdit: () => void;
  onDirtyChange: (value: boolean) => void; onSave: (body: string, original: Question) => Promise<string | null>;
  onAddImage: (questionId: string, file: File) => Promise<void>;
  onRemoveImage: (questionId: string, imageId: string) => Promise<void>;
  registerExitGuard?: (guard: MaterialsExitGuard | null) => void;
  onLinkPage?: (reference: MaterialReference, linked: boolean) => Promise<void>;
  onLinkBatch?: (links: ReferenceLink[]) => Promise<void>;
}) {
  const materials = useMaterialsNavigation(registerExitGuard);
  const [launcherTarget, setLauncherTarget] = useState<HTMLSpanElement | null>(null);
  const number = getQuestionsBySet(data, question.setId).findIndex(item => item.id === question.id) + 1;
  return <Layout><main className="library-page materials-study-page">
    <header className="library-page__header"><BackButton onClick={() => void materials.transition(onBack)} /><h1>追加解説・メモ</h1><span ref={setLauncherTarget} /></header>
    <div className="material-question-heading"><span>Q{number}</span><button type="button" className="material-reference-jump" disabled={!question.materialReferences?.length} title={question.materialReferences?.length ? '参照資料のページへ移動' : '参照ページが未設定です'} onClick={() => void materials.transition(async () => { await materials.drawer.current?.openReference(question.materialReferences?.[0]); })}>移動</button></div>
    <MaterialsDrawer ref={materials.drawer} problemSetId={question.setId} setIds={data.problemSets.map(item => item.id)} questionId={question.id} references={question.materialReferences} questions={data.questions.filter(item => item.setId === question.setId)} onLinkPage={onLinkPage} onLinkBatch={onLinkBatch} launcherTarget={launcherTarget} open={materials.open} onOpenChange={materials.setOpen} />
    {materials.error ? <p role="alert">{materials.error}</p> : null}
    <WeaknessDetail key={question.id} questionId={question.id} text={question.detailedAnswer?.body ?? question.detailedExplanation ?? ''} imageIds={question.detailedAnswer?.imageIds ?? []} onAddImage={file => onAddImage(question.id, file)} onRemoveImage={imageId => onRemoveImage(question.id, imageId)} onDirtyChange={onDirtyChange} onSave={async body => { const error = await onSave(body, question); if (error) throw new Error(error); }} />
  </main></Layout>;
}
