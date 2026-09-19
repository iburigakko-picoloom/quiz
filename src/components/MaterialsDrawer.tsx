import { forwardRef, type PointerEvent, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MaterialReference, Question } from '../types';
import type { ReferenceLink } from '../utils/referenceLinking';
import { ReferenceLinkDialog } from './ReferenceLinkDialog';
import { MaterialsPanel } from './MaterialsPanel';
import type { CategoryNoteDrawerHandle, CategoryNotePanelHandle } from './CategoryNoteDrawer';

export const MaterialsDrawer = forwardRef<CategoryNoteDrawerHandle, {
  problemSetId: string; setIds: string[]; questionId: string; references?: MaterialReference[]; open: boolean; onOpenChange: (open: boolean) => void; launcherTarget?: HTMLElement | null;
  onLinkPage?: (reference: MaterialReference, linked: boolean) => Promise<void>;
  questions?: Question[]; onLinkBatch?: (links: ReferenceLink[]) => Promise<void>;
}>(function MaterialsDrawer({ problemSetId, setIds, questionId, references, open, onOpenChange, onLinkPage, onLinkBatch, questions = [], launcherTarget }, ref) {
  const panel = useRef<CategoryNotePanelHandle>(null);
  const [error, setError] = useState('');
  const [linkDialog, setLinkDialog] = useState(false);
  const [reference, setReference] = useState<MaterialReference | undefined>(references?.[0]);
  const [keepPanel, setKeepPanel] = useState(open);
  const [referenceRequest, setReferenceRequest] = useState(0);
  const followedQuestion = useRef('');
  const drawer = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number; start: number } | null>(null);
  const [dragReveal, setDragReveal] = useState<number | null>(null);
  const suppressClick = useRef(false);
  const firstReference = references?.[0];
  useEffect(() => {
    const targetKey = `${questionId}/${firstReference?.materialId ?? ''}/${firstReference?.pageId ?? ''}`;
    if (followedQuestion.current === targetKey) return;
    let cancelled = false;
    void (async () => {
      await panel.current?.flush();
      if (cancelled) return;
      followedQuestion.current = targetKey;
      if (firstReference) { setReference(firstReference); setReferenceRequest(value => value + 1); }
      setError('');
    })().catch(() => { if (!cancelled) setError('書き込みを保存できないため、参照ページへ移動できませんでした。'); });
    return () => { cancelled = true; };
  }, [open, questionId, firstReference?.materialId, firstReference?.pageId]);
  useEffect(() => { if (open) setKeepPanel(true); }, [open]);
  useEffect(() => { document.body.classList.toggle('quiz-material-visible', open); return () => document.body.classList.remove('quiz-material-visible'); }, [open]);
  useLayoutEffect(() => {
    document.body.classList.add('quiz-material-enabled');
    document.body.classList.toggle('quiz-material-dragging', dragReveal !== null);
    document.body.style.setProperty('--materials-reveal', dragReveal !== null ? `${dragReveal}px` : open ? 'var(--tablet-note-width)' : '0px');
  }, [open, dragReveal]);
  useEffect(() => () => {
    document.body.classList.remove('quiz-material-enabled', 'quiz-material-dragging');
    document.body.style.removeProperty('--materials-reveal');
  }, []);
  const close = async () => { try { await panel.current?.flush(); onOpenChange(false); setError(''); return true; } catch { setError('保存できません。資料を閉じずに再度お試しください。'); return false; } };
  useImperativeHandle(ref, () => ({ close, flush: async () => { await panel.current?.flush(); } }));
  const openAt = async (target?: MaterialReference) => { try { await panel.current?.flush(); const next = target ?? firstReference; if (next) { setReference(next); setReferenceRequest(value => value + 1); } followedQuestion.current = `${questionId}/${firstReference?.materialId ?? ''}/${firstReference?.pageId ?? ''}`; setError(''); onOpenChange(true); } catch { setError('書き込みを保存できません。'); } };
  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || !drawer.current) return;
    const width = drawer.current.getBoundingClientRect().width;
    drag.current = { pointerId: event.pointerId, x: event.clientX, width, start: open ? width : 0 };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = start.x - event.clientX;
    if (Math.abs(delta) < 6 && !suppressClick.current) return;
    suppressClick.current = true;
    setKeepPanel(true);
    setDragReveal(Math.max(0, Math.min(start.width, start.start + delta)));
  };
  const endDrag = async (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === 'pointercancel') { suppressClick.current = true; setDragReveal(null); return; }
    if (suppressClick.current) {
      const delta = start.x - event.clientX;
      if (!open && delta > Math.min(70, start.width * .2)) await openAt();
      else if (open && delta < -Math.min(90, start.width * .2)) await close();
    }
    setDragReveal(null);
  };
  return <>
    {linkDialog && onLinkBatch ? <ReferenceLinkDialog setIds={setIds} questions={questions} onSave={onLinkBatch} onClose={() => setLinkDialog(false)} /> : null}
    {launcherTarget && !open ? createPortal(<button className="materials-mobile-launcher" type="button" aria-label="資料を開く" aria-expanded={open} onClick={() => void openAt()}><span aria-hidden="true">▤</span> 資料</button>, launcherTarget) : null}
    {createPortal(<><button type="button" className={`materials-edge-tab${open ? ' is-open' : ''}`} aria-label={open ? '資料を閉じる' : '資料を開く'} aria-expanded={open}
      onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={event => void endDrag(event)} onPointerCancel={event => void endDrag(event)}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; setDragReveal(null); } }}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (open) void close(); else void openAt(); }}><span aria-hidden="true">{open ? '›' : '‹'}</span><span className="materials-edge-tab__label">資料</span></button>
    <aside ref={drawer} className={`materials-drawer${open ? ' is-open' : ''}${dragReveal !== null ? ' is-dragging' : ''}`} style={dragReveal !== null ? { transform: `translateX(calc(100% - ${dragReveal}px))` } : undefined} aria-label="資料ビューア" aria-hidden={!open} inert={!open}>
      {error ? <p role="alert">{error}</p> : null}
      {open || keepPanel ? <MaterialsPanel ref={panel} setId={problemSetId} setIds={setIds} reference={reference} referenceRequest={referenceRequest} questionReferences={references} onOpenReference={target => void openAt(target)} onLinkPage={onLinkPage} onAdjustReferences={onLinkBatch ? () => setLinkDialog(true) : undefined} onClose={() => void close()} /> : null}
    </aside></>, document.body)}
  </>;
});
