import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MaterialReference } from '../types';
import { CategoryNotePanel, type CategoryNotePanelHandle } from './CategoryNoteDrawer';
import { annotationCategory, loadMaterialFile, loadMaterials, saveMaterials, storeMaterialPdf } from '../utils/materialStorage';
import { createId } from '../utils/id';
import { insertMaterialPage, moveMaterialPage, MAX_MATERIAL_PDF_BYTES, type MaterialIndex, type MaterialPage, type StudyMaterial } from '../utils/materialModel';
import './MaterialsPanel.css';

interface Props { setId: string; setIds?: string[]; category?: string; initialLegacy?: boolean; reference?: MaterialReference; referenceRequest?: number; onClose?: () => void; questionReferences?: MaterialReference[]; onLinkPage?: (reference: MaterialReference, linked: boolean) => Promise<void> }
export const MaterialsPanel = forwardRef<CategoryNotePanelHandle, Props>(function MaterialsPanel({ setId, setIds, category = '未分類', initialLegacy = false, reference, referenceRequest, onClose, questionReferences, onLinkPage }, ref) {
  const [index, setIndex] = useState<MaterialIndex | null>(null);
  const [ownerId, setOwnerId] = useState(setId);
  const [materialId, setMaterialId] = useState('');
  const [pageId, setPageId] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [displayed, setDisplayed] = useState<{ ownerId: string; materialId: string; page: MaterialPage; url?: string; aspect?: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const transitionLayer = useRef<HTMLDivElement>(null);
  const transitionDirection = useRef(1);
  const transitionVersion = useRef(0);
  const panel = useRef<CategoryNotePanelHandle>(null);
  const operation = useRef<Promise<void>>(Promise.resolve());
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const pdfCache = useRef<{ key: string; task: ReturnType<(typeof import('../utils/pdfReader'))['openPdf']> } | null>(null);
  useEffect(() => () => { void pdfCache.current?.task.destroy(); pdfCache.current = null; }, []);
  const material = index?.materials.find(item => item.id === materialId);
  const page = material?.pages.find(item => item.id === pageId);
  const pageIndex = material?.pages.findIndex(item => item.id === pageId) ?? -1;
  const pagePending = !legacy && !!page && displayed?.page.id !== page.id;
  const linked = questionReferences?.some(item => item.materialId === materialId && item.pageId === pageId) ?? false;
  const captureTransition = (direction = 1) => {
    const area = contentRef.current?.querySelector<HTMLElement>('.category-note-canvas-area');
    const layer = transitionLayer.current;
    if (!area || !layer) return;
    transitionVersion.current++; transitionDirection.current = direction;
    layer.classList.toggle('category-note-panel--material', !!area.closest('.category-note-panel--material'));
    const clone = area.cloneNode(true) as HTMLElement;
    const originalCanvas = area.querySelector('canvas');
    if (originalCanvas) clone.querySelector('canvas')?.getContext('2d')?.drawImage(originalCanvas, 0, 0);
    const rect = area.getBoundingClientRect(); const container = contentRef.current!.getBoundingClientRect();
    Object.assign(clone.style, { position: 'absolute', top: `${rect.top - container.top}px`, left: `${rect.left - container.left}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0' });
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    layer.replaceChildren(clone);
  };
  const finishTransition = useCallback(() => {
    const layer = transitionLayer.current; const outgoing = layer?.firstElementChild;
    const incoming = contentRef.current?.querySelector('.category-note-panel .category-note-canvas-area');
    if (!layer || !outgoing || !incoming) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { layer.replaceChildren(); return; }
    const version = transitionVersion.current; const offset = transitionDirection.current * 28;
    incoming.animate([{ opacity: 0.3, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
    const exit = outgoing.animate([{ opacity: 1 }, { opacity: 0, transform: `translateX(${-offset}px)` }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
    void exit.finished.then(() => { if (version === transitionVersion.current) layer.replaceChildren(); }, () => undefined);
  }, []);
  useImperativeHandle(ref, () => ({ flush: async () => { await operation.current; await panel.current?.flush(); } }));
  const run = (action: () => Promise<void>) => {
    if (lock.current) return;
    if (menu.current) menu.current.open = false;
    lock.current = true; setBusy(true); setError('');
    const pending = (async () => { await panel.current?.flush(); await action(); })();
    // Failed metadata changes are never applied to the visible index. Wait for
    // completion on exit, then let the handwriting panel enforce its own guard.
    operation.current = pending.then(() => undefined, () => undefined);
    void pending.catch(err => setError(err instanceof Error ? err.message : '資料を保存できませんでした。')).finally(() => { lock.current = false; setBusy(false); });
  };
  useEffect(() => {
    let cancelled = false;
    if (!reference || reference.materialId !== displayed?.materialId || reference.pageId !== displayed?.page.id) captureTransition();
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
        setMaterialId(''); setPageId(''); setDisplayed(null); transitionLayer.current?.replaceChildren(); setError('参照資料がこの端末にありません。元の端末の資料を含むバックアップを確認してください。'); return;
      }
      setMaterialId(selected?.id ?? ''); setPageId(reference?.pageId ?? selected?.pages[0]?.id ?? ''); setLegacy(initialLegacy && !reference);
    })().catch(err => { if (!cancelled) { transitionLayer.current?.replaceChildren(); setError(String(err.message ?? err)); } });
    return () => { cancelled = true; };
  }, [setId, reference?.materialId, reference?.pageId, referenceRequest]);

  useEffect(() => {
    if (legacy) return;
    if (!material || !page) { if (index) { setDisplayed(null); transitionLayer.current?.replaceChildren(); } return; }
    if (page.kind === 'blank') { setDisplayed({ ownerId, materialId: material.id, page }); return; }
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const { openPdf, pdfBytes } = await import('../utils/pdfReader');
      const key = `${ownerId}/${material.id}`;
      if (pdfCache.current?.key !== key) {
        const raw = await loadMaterialFile(ownerId, material.id);
        if (disposed) return;
        await pdfCache.current?.task.destroy();
        if (disposed) return;
        pdfCache.current = { key, task: openPdf(pdfBytes(raw)) };
      }
      const task = pdfCache.current.task;
      const doc = await task.promise;
      const pdfPage = await doc.getPage(page.pdfPage!);
      if (disposed) return;
      const native = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1800 / Math.max(native.width, native.height)) });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const rendering = pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
      cleanup = () => rendering.cancel();
      await rendering.promise;
      if (!disposed) setDisplayed({ ownerId, materialId: material.id, page, url: canvas.toDataURL('image/png'), aspect: native.width / native.height });
      canvas.width = 0; canvas.height = 0;
    })().catch(err => { if (!disposed) { transitionLayer.current?.replaceChildren(); setError(`PDFを表示できません: ${err.message ?? err}`); } });
    return () => { disposed = true; cleanup?.(); };
  }, [material?.id, page?.id, page?.pdfPage, ownerId, legacy]);

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
      captureTransition(); setIndex(next); setMaterialId(added.id); setPageId(added.pages[0].id); setLegacy(false);
    } finally { await task.destroy(); }
  });
  return <section className="materials-panel" aria-label="資料" aria-busy={busy}>
    <div className="materials-controls">
      <select aria-label="資料を選択" disabled={!index || busy} value={legacy ? '__legacy' : materialId} onChange={event => { const value = event.target.value; run(async () => { captureTransition(); setLegacy(value === '__legacy'); setMaterialId(value); setPageId(index?.materials.find(item => item.id === value)?.pages[0]?.id ?? ''); }); }}>
        <option value="">資料を選択</option>{index?.materials.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="__legacy">以前の手書きノート（{category}）</option>
      </select>
      {material && !legacy ? <div className="materials-pagination"><button aria-label="前のページ" disabled={busy || pagePending || pageIndex <= 0} onClick={() => goToPage(material.pages[pageIndex - 1].id)}>‹</button><select aria-label="ページ" value={pageId} disabled={busy || pagePending} onChange={event => goToPage(event.target.value)}>{material.pages.map((item, n) => <option key={item.id} value={item.id}>{n + 1}/{material.pages.length}</option>)}</select><button aria-label="次のページ" disabled={busy || pagePending || pageIndex >= material.pages.length - 1} onClick={() => goToPage(material.pages[pageIndex + 1].id)}>›</button></div> : null}
      <details ref={menu} className="materials-menu"><summary aria-label="資料の操作" title="資料の操作">•••</summary><div>
        {onLinkPage && material && page && !legacy ? <><button disabled={busy || pagePending} onClick={() => run(async () => onLinkPage({ materialId, pageId }, !linked))}>{linked ? 'このページの紐付けを解除' : 'このページを問題に紐付け'}</button><hr/></> : null}
        <button type="button" disabled={!index || busy} onClick={() => { if (menu.current) menu.current.open = false; fileInput.current?.click(); }}>PDFを追加</button>
        <button type="button" disabled={!index || busy} onClick={() => run(async () => { if (!index) return; const added: StudyMaterial = { id: createId('material'), title: `白紙の資料 ${index.materials.length + 1}`, pages: [{ id: createId('page'), kind: 'blank' }] }; const next = { ...index, materials: [...index.materials, added] }; await saveMaterials(next); setIndex(next); setMaterialId(added.id); setPageId(added.pages[0].id); setLegacy(false); })}>白紙の資料を追加</button>
        {material && !legacy ? <><hr/><button disabled={busy} onClick={() => addBlank(false)}>前に白紙ページ</button><button disabled={busy} onClick={() => addBlank(true)}>後ろに白紙ページ</button><hr/><button disabled={busy || pageIndex <= 0} onClick={() => move(-1)}>このページを前へ移動</button><button disabled={busy || pageIndex >= material.pages.length - 1} onClick={() => move(1)}>このページを後ろへ移動</button></> : null}
      </div></details>
      {onClose ? <button className="materials-close" type="button" aria-label="資料を閉じて問題に戻る" title="問題に戻る" disabled={busy} onClick={() => run(async () => onClose())}>×</button> : null}
      <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) addPdf(file); }} />
    </div>
    {error ? <p className="materials-error" role="alert">{error}</p> : null}
    <div ref={contentRef} className={`materials-content${pagePending ? ' is-page-loading' : ''}`} aria-busy={pagePending}>
      {legacy ? <CategoryNotePanel key={`legacy-${category}`} ref={panel} problemSetId={setId} category={category} onReady={finishTransition} /> : displayed ? <CategoryNotePanel key={`${displayed.materialId}-${displayed.page.id}`} ref={panel} problemSetId={displayed.ownerId} category={annotationCategory(displayed.materialId, displayed.page.id)} singlePage backgroundUrl={displayed.url} pageAspect={displayed.aspect} onReady={finishTransition} pageNavigation={{ hasPrevious: !pagePending && pageIndex > 0, hasNext: !pagePending && pageIndex < (material?.pages.length ?? 0) - 1, onNavigate: delta => { const next = material?.pages[pageIndex + delta]; if (next) goToPage(next.id); } }} /> : <div className="materials-empty"><p>{page ? 'PDFを読み込み中…' : '資料を見ながら、書き込もう。'}</p>{!page ? <button disabled={!index || busy} onClick={() => fileInput.current?.click()}>PDFを追加</button> : null}<small>1ファイル50MB・500ページまで。PDFは専用の非公開ストレージに同期します。</small></div>}
      <div ref={transitionLayer} className="materials-transition-cover" aria-hidden="true" inert />
    </div>
  </section>;
});
