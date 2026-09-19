import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MaterialReference } from '../types';
import { MaterialsPanel } from './MaterialsPanel';
import type { CategoryNoteDrawerHandle, CategoryNotePanelHandle } from './CategoryNoteDrawer';

export const MaterialsDrawer = forwardRef<CategoryNoteDrawerHandle, {
  problemSetId: string; setIds: string[]; category?: string; references?: MaterialReference[]; open: boolean; onOpenChange: (open: boolean) => void;
}>(function MaterialsDrawer({ problemSetId, setIds, category, references, open, onOpenChange }, ref) {
  const panel = useRef<CategoryNotePanelHandle>(null);
  const [error, setError] = useState('');
  const [reference, setReference] = useState<MaterialReference>();
  const [keepPanel, setKeepPanel] = useState(open);
  const [referenceRequest, setReferenceRequest] = useState(0);
  useEffect(() => { if (open) setKeepPanel(true); }, [open]);
  useEffect(() => { document.body.classList.toggle('quiz-material-visible', open); return () => document.body.classList.remove('quiz-material-visible'); }, [open]);
  const close = async () => { try { await panel.current?.flush(); onOpenChange(false); setError(''); return true; } catch { setError('保存できません。資料を閉じずに再度お試しください。'); return false; } };
  useImperativeHandle(ref, () => ({ close, flush: async () => { await panel.current?.flush(); } }));
  const openAt = async (target?: MaterialReference) => { try { await panel.current?.flush(); if (target) { setReference(target); setReferenceRequest(value => value + 1); } setError(''); onOpenChange(true); } catch { setError('書き込みを保存できません。'); } };
  return <>
    <div className="materials-launcher"><button onClick={() => void openAt()}>資料</button>{references?.map((item, i) => <button key={`${item.materialId}-${item.pageId}`} onClick={() => void openAt(item)}>参照資料{references.length > 1 ? ` ${i + 1}` : ''}</button>)}</div>
    {createPortal(<aside className={`materials-drawer${open ? ' is-open' : ''}`} aria-label="資料ビューア" aria-hidden={!open} inert={!open}>
      {error ? <p role="alert">{error}</p> : null}
      {open || keepPanel ? <MaterialsPanel ref={panel} setId={problemSetId} setIds={setIds} category={category} reference={reference} referenceRequest={referenceRequest} onClose={() => void close()} /> : null}
    </aside>, document.body)}
  </>;
});
