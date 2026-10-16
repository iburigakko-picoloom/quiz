import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { MissingResourceState } from '../components/MissingResourceState';
import { MaterialsPanel } from '../components/MaterialsPanel';
import type { CategoryNotePanelHandle } from '../components/CategoryNoteDrawer';
import { ReferenceLinkDialog } from '../components/ReferenceLinkDialog';
import type { ReferenceLink } from '../utils/referenceLinking';

interface NoteListScreenProps {
  data: AppData; setId: string; onBack: () => void; initialCategory?: string;
  onOpenQuestions?: () => void;
  onLinkBatch?: (links: ReferenceLink[]) => Promise<void>;
  registerExitGuard?: (guard: ((proceed: () => void) => Promise<boolean>) | null) => void;
}
export function NoteListScreen({ data, setId, onBack, onOpenQuestions, registerExitGuard, onLinkBatch }: NoteListScreenProps) {
  const panel = useRef<CategoryNotePanelHandle>(null);
  const [error, setError] = useState('');
  const [linkDialog,setLinkDialog]=useState<{materialId?:string;pageId?:string}|null>(null);
  const transition = async (proceed: () => void) => {
    try { await panel.current?.flush(); setError(''); proceed(); return true; }
    catch { setError('資料を保存できません。保存を確認してから移動してください。'); return false; }
  };
  useEffect(() => { registerExitGuard?.(transition); return () => registerExitGuard?.(null); }, [registerExitGuard]);
  if (!data.problemSets.some(set => set.id === setId)) return <Layout><MissingResourceState title="問題セットが見つかりません" description="資料を表示できません。" onAction={onBack} /></Layout>;
  return <Layout><main className="materials-screen">
    <header><BackButton onClick={() => void transition(onBack)} /><h1>{data.problemSets.find(set => set.id === setId)?.title ?? '資料'}</h1>
    {onOpenQuestions ? <button onClick={() => void transition(onOpenQuestions)}>問題一覧</button> : null}</header>
    {error ? <p role="alert">{error}</p> : null}
    <MaterialsPanel ref={panel} setId={setId} setIds={data.problemSets.map(set => set.id)} onAdjustReferences={onLinkBatch?(materialId,pageId)=>setLinkDialog({materialId,pageId}):undefined} />
    {linkDialog&&onLinkBatch?<ReferenceLinkDialog setId={setId} questions={data.questions.filter(q=>q.setId===setId)} initialMaterialId={linkDialog.materialId} initialPageId={linkDialog.pageId} onSave={onLinkBatch} onClose={()=>setLinkDialog(null)}/>:null}
  </main></Layout>;
}
