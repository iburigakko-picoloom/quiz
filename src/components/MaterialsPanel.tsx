import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MaterialReference } from '../types';
import { CategoryNotePanel, type CategoryNotePanelHandle } from './CategoryNoteDrawer';
import { annotationCategory, loadMaterials, saveMaterials, storeMaterialPdf } from '../utils/materialStorage';
import { MaterialPreviewCache, type MaterialPagePreview } from '../utils/materialPreview';
import { createId } from '../utils/id';
import { insertMaterialPage, moveMaterialPage, MAX_MATERIAL_PDF_BYTES, type MaterialIndex, type MaterialPage, type StudyMaterial } from '../utils/materialModel';
import './MaterialsPanel.css';

interface Props { setId: string; setIds?: string[]; reference?: MaterialReference; referenceRequest?: number; onClose?: () => void; onAdjustReferences?: () => void; questionReferences?: MaterialReference[]; onOpenReference?: (reference: MaterialReference) => void; onLinkPage?: (reference: MaterialReference, linked: boolean) => Promise<void> }
export const MaterialsPanel = forwardRef<CategoryNotePanelHandle, Props>(function MaterialsPanel({ setId, setIds, reference, referenceRequest, onClose, onAdjustReferences, questionReferences, onOpenReference, onLinkPage }, ref) {
  const [index, setIndex] = useState<MaterialIndex | null>(null);
  const [ownerId, setOwnerId] = useState(setId);
  const [materialId, setMaterialId] = useState('');
  const [pageId, setPageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [displayed, setDisplayed] = useState<{ ownerId: string; materialId: string; page: MaterialPage; url?: string; aspect?: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const transitionLayer = useRef<HTMLDivElement>(null);
  const transitionDirection = useRef(1);
  const transitionDistance = useRef(1);
  const transitionVersion = useRef(0);
  const stopAnimation = useRef<(() => void) | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const previews = useRef(new MaterialPreviewCache());
  const [neighbours, setNeighbours] = useState<{ pageId: string; previous?: MaterialPagePreview; next?: MaterialPagePreview }>({ pageId: '' });
  const panel = useRef<CategoryNotePanelHandle>(null);
  const operation = useRef<Promise<void>>(Promise.resolve());
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => { previews.current.clear(); stopAnimation.current?.(); }, []);
  const material = index?.materials.find(item => item.id === materialId);
  const page = material?.pages.find(item => item.id === pageId);
  const pageIndex = material?.pages.findIndex(item => item.id === pageId) ?? -1;
  const pagePending = !!page && displayed?.page.id !== page.id;
  const linked = questionReferences?.some(item => item.materialId === materialId && item.pageId === pageId) ?? false;
  const clearTransition = useCallback(() => {
    stopAnimation.current?.(); stopAnimation.current = null;
    transitionLayer.current?.replaceChildren(); setTransitioning(false);
    panel.current?.resetPageSlide?.();
  }, []);
  const captureTransition = (direction = 1, distance = 1) => {
    const area = contentRef.current?.querySelector<HTMLElement>('.category-note-canvas-area');
    const layer = transitionLayer.current;
    if (!area || !layer) return;
    stopAnimation.current?.(); stopAnimation.current = null;
    setTransitioning(true);
    transitionVersion.current++; transitionDirection.current = direction;
    transitionDistance.current = Math.max(1, distance);
    layer.classList.toggle('category-note-panel--material', !!area.closest('.category-note-panel--material'));
    const clone = area.cloneNode(true) as HTMLElement;
    const originalCanvas = area.querySelector('canvas');
    if (originalCanvas) clone.querySelector('canvas')?.getContext('2d')?.drawImage(originalCanvas, 0, 0);
    const rail = clone.querySelector<HTMLElement>('.category-note-page-rail');
    if (rail) rail.style.transition = 'none';
    const rect = area.getBoundingClientRect(); const container = contentRef.current!.getBoundingClientRect();
    Object.assign(clone.style, { position: 'absolute', top: `${rect.top - container.top}px`, left: `${rect.left - container.left}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0' });
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    layer.replaceChildren(clone);
  };
  const finishTransition = useCallback(() => {
    const layer = transitionLayer.current; const outgoing = layer?.firstElementChild;
    const incoming = contentRef.current?.querySelector<HTMLElement>('.category-note-panel .category-note-page--active');
    const rail = outgoing?.querySelector<HTMLElement>('.category-note-page-rail');
    if (!layer || !incoming || !rail || stopAnimation.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { clearTransition(); return; }
    const version = transitionVersion.current;
    const copy = incoming.cloneNode(true) as HTMLElement;
    const canvas = incoming.querySelector('canvas');
    if (canvas) copy.querySelector('canvas')?.getContext('2d')?.drawImage(canvas, 0, 0);
    rail.children[transitionDirection.current > 0 ? 2 : 0]?.replaceChildren(copy);
    let destination = transitionDirection.current > 0 ? -66.666667 : 0;
    const fastJump = transitionDistance.current > 1;
    if (fastJump) {
      // A few lightweight paper silhouettes convey skipped pages without
      // rendering every PDF page or delaying arrival at a distant reference.
      const source = rail.children[1].cloneNode(true) as HTMLElement;
      const originalCanvas = rail.children[1].querySelector('canvas');
      if (originalCanvas) source.querySelector('canvas')?.getContext('2d')?.drawImage(originalCanvas, 0, 0);
      const target = source.cloneNode(false) as HTMLElement; target.append(copy);
      const count = Math.min(3, transitionDistance.current - 1);
      const papers = Array.from({ length: count }, () => {
        const slot = source.cloneNode(false) as HTMLElement;
        const paper = document.createElement('div'); paper.className = 'category-note-page materials-rushing-page';
        paper.style.aspectRatio = incoming.style.aspectRatio || '210 / 297';
        slot.append(paper); return slot;
      });
      const slots = transitionDirection.current > 0 ? [source, ...papers, target] : [target, ...papers, source];
      rail.replaceChildren(...slots);
      rail.style.width = `${slots.length * 100}%`;
      rail.style.gridTemplateColumns = `repeat(${slots.length}, minmax(0, 1fr))`;
      const end = -(slots.length - 1) / slots.length * 100;
      rail.style.transform = `translate3d(${transitionDirection.current > 0 ? 0 : end}%,0,0)`;
      destination = transitionDirection.current > 0 ? end : 0;
    }
    // Same three-slot rail and 220ms easing as the original notebook. Continue
    // from the swipe offset, then swap the already-painted centre page in place.
    let timer = 0; let frame = 0;
    const finish = () => { if (version === transitionVersion.current) clearTransition(); };
    const onEnd = (event: TransitionEvent) => { if (event.target === rail && event.propertyName === 'transform') finish(); };
    stopAnimation.current = () => { cancelAnimationFrame(frame); window.clearTimeout(timer); rail.removeEventListener('transitionend', onEnd); };
    rail.style.transition = 'none'; void rail.offsetHeight;
    rail.addEventListener('transitionend', onEnd);
    rail.style.transition = fastJump ? 'transform 360ms cubic-bezier(.45,0,.15,1)' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
    frame = requestAnimationFrame(() => {
      rail.style.transform = `translate3d(${destination}%, 0, 0)`;
      timer = window.setTimeout(finish, fastJump ? 420 : 280);
    });
  }, [clearTransition]);
  useImperativeHandle(ref, () => ({ flush: async () => { await operation.current; await panel.current?.flush(); } }));
  const run = (action: () => Promise<void>) => {
    if (lock.current || transitioning) return Promise.resolve(false);
    if (menu.current) menu.current.open = false;
    lock.current = true; setBusy(true); setError('');
    const pending = (async () => { await panel.current?.flush(); await action(); })();
    // Failed metadata changes are never applied to the visible index. Wait for
    // completion on exit, then let the handwriting panel enforce its own guard.
    operation.current = pending.then(() => undefined, () => undefined);
    return pending.then(() => true, err => { clearTransition(); setError(err instanceof Error ? err.message : '資料を保存できませんでした。'); return false; }).finally(() => { lock.current = false; setBusy(false); });
  };
  useEffect(() => {
    let cancelled = false;
    const delta = reference && material?.id === reference.materialId ? material.pages.findIndex(item => item.id === reference.pageId) - pageIndex : 1;
    if (!reference || reference.materialId !== displayed?.materialId || reference.pageId !== displayed?.page.id) captureTransition(delta < 0 ? -1 : 1, Math.abs(delta));
    setIndex(null); setError('');
    void (async () => {
      let found = await loadMaterials(setId);
      if (reference && !found.materials.some(item => item.id === reference.materialId)) {
        for (const id of setIds ?? []) { if (id === setId) continue; const candidate = await loadMaterials(id); if (candidate.materials.some(item => item.id === reference.materialId)) { found = candidate; break; } }
      }
      if (cancelled) return;
      setIndex(found); setOwnerId(found.problemSetId);
      const selected = reference ? found.materials.find(item => item.id === reference.materialId) : found.materials[0];
      if (reference && (!selected || !selected.pages.some(item => item.id === reference.pageId))) {
        setMaterialId(''); setPageId(''); setDisplayed(null); clearTransition(); setError('参照資料がこの端末にありません。元の端末の資料を含むバックアップを確認してください。'); return;
      }
      setMaterialId(selected?.id ?? ''); setPageId(reference?.pageId ?? selected?.pages[0]?.id ?? '');
    })().catch(err => { if (!cancelled) { clearTransition(); setError(String(err.message ?? err)); } });
    return () => { cancelled = true; };
  }, [setId, reference?.materialId, reference?.pageId, referenceRequest]);

  useEffect(() => {
    if (!material || !page) { if (index) { setDisplayed(null); clearTransition(); } return; }
    let disposed = false;
    void (async () => {
      const preview = await previews.current.load(ownerId, material.id, page);
      if (!disposed) setDisplayed({ ownerId, materialId: material.id, page, url: preview.url, aspect: preview.aspect });
    })().catch(err => { if (!disposed) { clearTransition(); if (displayed) { setMaterialId(displayed.materialId); setPageId(displayed.page.id); } setError(`資料を表示できません: ${err.message ?? err}`); } });
    return () => { disposed = true; };
  }, [material?.id, page?.id, page?.pdfPage, ownerId]);

  useEffect(() => {
    if (!displayed || !material || displayed.materialId !== material.id) return;
    let disposed = false;
    const current = material.pages.findIndex(item => item.id === displayed.page.id);
    setNeighbours({ pageId: displayed.page.id });
    // Sequential background work limits transient canvas memory. Annotation
    // images are read afresh so returning to a page never shows stale ink.
    void (async () => {
      for (const [side, adjacent] of [['next', material.pages[current + 1]], ['previous', material.pages[current - 1]]] as const) {
        if (!adjacent || disposed) continue;
        try {
          const preview = await previews.current.load(ownerId, material.id, adjacent);
          if (!disposed) setNeighbours(value => ({ ...value, [side]: preview }));
        } catch { /* A failed prefetch is retried, with an error, on navigation. */ }
      }
    })();
    return () => { disposed = true; };
  }, [displayed?.page.id, displayed?.materialId, material?.pages, ownerId]);

  const update = async (nextMaterial: StudyMaterial) => {
    if (!index) return;
    const next = { ...index, materials: index.materials.map(item => item.id === nextMaterial.id ? nextMaterial : item) };
    await saveMaterials(next); setIndex(next);
  };
  const goToPage = (id: string) => run(async () => {
    if (!material || id === pageId) return;
    captureTransition(material.pages.findIndex(item => item.id === id) < pageIndex ? -1 : 1);
    setPageId(id);
  });
  const addBlank = (after: boolean) => run(async () => {
    if (!material) return;
    const blank = { id: createId('page'), kind: 'blank' as const };
    await update(insertMaterialPage(material, blank, pageIndex + (after ? 1 : 0))); captureTransition(after ? 1 : -1); setPageId(blank.id);
  });
  const move = (delta: number) => run(async () => {
    if (!material || pageIndex + delta < 0 || pageIndex + delta >= material.pages.length) return;
    await update(moveMaterialPage(material, pageId, pageIndex + delta));
  });
  const addPdf = (file: File) => run(async () => {
    if (!index) throw new Error('資料一覧を読み込んでから登録してください。');
    if (file.size > MAX_MATERIAL_PDF_BYTES) throw new Error('PDFは1ファイル50MB以下にしてください。');
    if (!file.name.toLowerCase().endsWith('.pdf')) throw new Error('PDFファイルを選んでください。');
    const { openPdf } = await import('../utils/pdfReader');
    const task = openPdf(new Uint8Array(await file.arrayBuffer()));
    try {
      const doc = await task.promise;
      if (doc.numPages > 500) throw new Error('PDFは500ページ以下にしてください。');
      const added = await storeMaterialPdf(ownerId, file, doc.numPages);
      const next = { ...index, materials: [...index.materials, added] }; await saveMaterials(next);
      captureTransition(); setIndex(next); setMaterialId(added.id); setPageId(added.pages[0].id);
    } finally { await task.destroy(); }
  });
  return <section className="materials-panel" aria-label="資料" aria-busy={busy}>
    <div className="materials-controls">
      <select aria-label="資料を選択" disabled={!index || busy} value={materialId} onChange={event => { const value = event.target.value; run(async () => { captureTransition(); setMaterialId(value); setPageId(index?.materials.find(item => item.id === value)?.pages[0]?.id ?? ''); }); }}>
        <option value="">資料を選択</option>{index?.materials.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      {material ? <div className="materials-pagination"><button aria-label="前のページ" disabled={busy || pagePending || pageIndex <= 0} onClick={() => goToPage(material.pages[pageIndex - 1].id)}>‹</button><select aria-label="ページ" value={pageId} disabled={busy || pagePending} onChange={event => goToPage(event.target.value)}>{material.pages.map((item, n) => <option key={item.id} value={item.id}>p{n + 1}</option>)}</select><button aria-label="次のページ" disabled={busy || pagePending || pageIndex >= material.pages.length - 1} onClick={() => goToPage(material.pages[pageIndex + 1].id)}>›</button></div> : null}
      <details ref={menu} className="materials-menu"><summary aria-label="資料の操作" title="資料の操作">•••</summary><div>
        {onAdjustReferences ? <><button disabled={busy || pagePending || transitioning} onClick={() => run(async () => onAdjustReferences())}>参照ページを調整</button><hr/></> : null}
        {onOpenReference && (questionReferences?.length ?? 0) > 1 ? <>{questionReferences?.map((item, i) => <button key={`${item.materialId}/${item.pageId}`} disabled={busy} onClick={() => { if (menu.current) menu.current.open = false; onOpenReference(item); }}>参照資料 {i + 1}へ移動</button>)}<hr/></> : null}
        {onLinkPage && material && page ? <><button disabled={busy || pagePending} onClick={() => run(async () => onLinkPage({ materialId, pageId }, !linked))}>{linked ? 'このページの紐付けを解除' : 'このページを問題に紐付け'}</button><hr/></> : null}
        <button type="button" disabled={!index || busy} onClick={() => { if (menu.current) menu.current.open = false; fileInput.current?.click(); }}>PDFを追加</button>
        <button type="button" disabled={!index || busy} onClick={() => run(async () => { if (!index) return; const added: StudyMaterial = { id: createId('material'), title: `白紙の資料 ${index.materials.length + 1}`, pages: [{ id: createId('page'), kind: 'blank' }] }; const next = { ...index, materials: [...index.materials, added] }; await saveMaterials(next); setIndex(next); setMaterialId(added.id); setPageId(added.pages[0].id); })}>白紙の資料を追加</button>
        {material ? <><hr/><button disabled={busy} onClick={() => addBlank(false)}>前に白紙ページ</button><button disabled={busy} onClick={() => addBlank(true)}>後ろに白紙ページ</button><hr/><button disabled={busy || pageIndex <= 0} onClick={() => move(-1)}>このページを前へ移動</button><button disabled={busy || pageIndex >= material.pages.length - 1} onClick={() => move(1)}>このページを後ろへ移動</button></> : null}
      </div></details>
      {onClose ? <button className="materials-close" type="button" aria-label="資料を閉じて問題に戻る" title="問題に戻る" disabled={busy} onClick={() => run(async () => onClose())}>×</button> : null}
      <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) addPdf(file); }} />
    </div>
    {error ? <p className="materials-error" role="alert">{error}</p> : null}
    <div ref={contentRef} className={`materials-content${pagePending || transitioning ? ' is-page-loading' : ''}`} aria-busy={pagePending || transitioning}>
      {displayed ? <CategoryNotePanel key={`${displayed.materialId}-${displayed.page.id}`} ref={panel} problemSetId={displayed.ownerId} category={annotationCategory(displayed.materialId, displayed.page.id)} singlePage backgroundUrl={displayed.url} pageAspect={displayed.aspect} onReady={finishTransition} onUnavailable={clearTransition} pageNavigation={{ hasPrevious: !pagePending && !transitioning && pageIndex > 0, hasNext: !pagePending && !transitioning && pageIndex < (material?.pages.length ?? 0) - 1, previous: neighbours.pageId === displayed.page.id ? neighbours.previous : undefined, next: neighbours.pageId === displayed.page.id ? neighbours.next : undefined, onNavigate: delta => { const next = material?.pages[pageIndex + delta]; return next ? goToPage(next.id) : Promise.resolve(false); } }} /> : <div className="materials-empty"><p>{page ? 'PDFを読み込み中…' : '資料を見ながら、書き込もう。'}</p>{!page ? <button disabled={!index || busy} onClick={() => fileInput.current?.click()}>PDFを追加</button> : null}<small>1ファイル50MB・500ページまで。PDFは専用の非公開ストレージに同期します。</small></div>}
      <div ref={transitionLayer} className="materials-transition-cover" aria-hidden="true" inert />
    </div>
  </section>;
});
