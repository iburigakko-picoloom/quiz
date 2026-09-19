import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MaterialReference } from '../types';
import { CategoryNotePanel, type CategoryNotePanelHandle } from './CategoryNoteDrawer';
import { annotationCategory, loadMaterialFile, loadMaterials, saveMaterials, storeMaterialPdf } from '../utils/materialStorage';
import { createId } from '../utils/id';
import { insertMaterialPage, moveMaterialPage, MAX_MATERIAL_PDF_BYTES, type MaterialIndex, type StudyMaterial } from '../utils/materialModel';
import './MaterialsPanel.css';

interface Props { setId: string; setIds?: string[]; category?: string; initialLegacy?: boolean; reference?: MaterialReference; referenceRequest?: number; onClose?: () => void }
export const MaterialsPanel = forwardRef<CategoryNotePanelHandle, Props>(function MaterialsPanel({ setId, setIds, category = '未分類', initialLegacy = false, reference, referenceRequest, onClose }, ref) {
  const [index, setIndex] = useState<MaterialIndex | null>(null);
  const [ownerId, setOwnerId] = useState(setId);
  const [materialId, setMaterialId] = useState('');
  const [pageId, setPageId] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ key: string; url: string; aspect: number } | null>(null);
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
    setIndex(null); setPreview(null); setError('');
    void (async () => {
      let found = await loadMaterials(setId);
      if (reference && !found.materials.some(item => item.id === reference.materialId)) {
        for (const id of setIds ?? []) { if (id === setId) continue; const candidate = await loadMaterials(id); if (candidate.materials.some(item => item.id === reference.materialId)) { found = candidate; break; } }
      }
      if (cancelled) return;
      setIndex(found); setOwnerId(found.problemSetId);
      const selected = reference ? found.materials.find(item => item.id === reference.materialId) : found.materials[0];
      if (reference && (!selected || !selected.pages.some(item => item.id === reference.pageId))) {
        setMaterialId(''); setPageId(''); setError('参照資料がこの端末にありません。元の端末の資料を含むバックアップを確認してください。'); return;
      }
      setMaterialId(selected?.id ?? ''); setPageId(reference?.pageId ?? selected?.pages[0]?.id ?? ''); setLegacy(initialLegacy && !reference);
    })().catch(err => { if (!cancelled) setError(String(err.message ?? err)); });
    return () => { cancelled = true; };
  }, [setId, reference?.materialId, reference?.pageId, referenceRequest]);

  useEffect(() => {
    if (!material || !page || page.kind !== 'pdf' || legacy) { setPreview(null); return; }
    let disposed = false;
    let cleanup: (() => void) | undefined;
    setPreview(null);
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
      if (!disposed) setPreview({ key: page.id, url: canvas.toDataURL('image/png'), aspect: native.width / native.height });
      canvas.width = 0; canvas.height = 0;
    })().catch(err => { if (!disposed) setError(`PDFを表示できません: ${err.message ?? err}`); });
    return () => { disposed = true; cleanup?.(); };
  }, [material?.id, page?.id, page?.pdfPage, ownerId, legacy]);

  const update = async (nextMaterial: StudyMaterial) => {
    if (!index) return;
    const next = { ...index, materials: index.materials.map(item => item.id === nextMaterial.id ? nextMaterial : item) };
    await saveMaterials(next); setIndex(next);
  };
  const addBlank = (after: boolean) => run(async () => {
    if (!material) return;
    const blank = { id: createId('page'), kind: 'blank' as const };
    await update(insertMaterialPage(material, blank, pageIndex + (after ? 1 : 0))); setPageId(blank.id);
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
      setIndex(next); setMaterialId(added.id); setPageId(added.pages[0].id); setLegacy(false);
    } finally { await task.destroy(); }
  });
  return <section className="materials-panel" aria-label="資料" aria-busy={busy}>
    <div className="materials-controls">
      <select aria-label="資料を選択" disabled={!index || busy} value={legacy ? '__legacy' : materialId} onChange={event => { const value = event.target.value; run(async () => { setLegacy(value === '__legacy'); setMaterialId(value); setPageId(index?.materials.find(item => item.id === value)?.pages[0]?.id ?? ''); }); }}>
        <option value="">資料を選択</option>{index?.materials.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="__legacy">以前の手書きノート（{category}）</option>
      </select>
      {material && !legacy ? <div className="materials-pagination"><button aria-label="前のページ" disabled={busy || pageIndex <= 0} onClick={() => run(async () => setPageId(material.pages[pageIndex - 1].id))}>‹</button><select aria-label="ページ" value={pageId} disabled={busy} onChange={event => { const id = event.target.value; run(async () => setPageId(id)); }}>{material.pages.map((item, n) => <option key={item.id} value={item.id}>{n + 1}/{material.pages.length}</option>)}</select><button aria-label="次のページ" disabled={busy || pageIndex >= material.pages.length - 1} onClick={() => run(async () => setPageId(material.pages[pageIndex + 1].id))}>›</button></div> : null}
      <details ref={menu} className="materials-menu"><summary aria-label="資料の操作" title="資料の操作">•••</summary><div>
        <button type="button" disabled={!index || busy} onClick={() => { if (menu.current) menu.current.open = false; fileInput.current?.click(); }}>PDFを追加</button>
        <button type="button" disabled={!index || busy} onClick={() => run(async () => { if (!index) return; const added: StudyMaterial = { id: createId('material'), title: `白紙の資料 ${index.materials.length + 1}`, pages: [{ id: createId('page'), kind: 'blank' }] }; const next = { ...index, materials: [...index.materials, added] }; await saveMaterials(next); setIndex(next); setMaterialId(added.id); setPageId(added.pages[0].id); setLegacy(false); })}>白紙の資料を追加</button>
        {material && !legacy ? <><hr/><button disabled={busy} onClick={() => addBlank(false)}>前に白紙ページ</button><button disabled={busy} onClick={() => addBlank(true)}>後ろに白紙ページ</button><hr/><button disabled={busy || pageIndex <= 0} onClick={() => move(-1)}>このページを前へ移動</button><button disabled={busy || pageIndex >= material.pages.length - 1} onClick={() => move(1)}>このページを後ろへ移動</button></> : null}
      </div></details>
      {onClose ? <button className="materials-close" type="button" aria-label="資料を閉じて問題に戻る" title="問題に戻る" disabled={busy} onClick={() => run(async () => onClose())}>×</button> : null}
      <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) addPdf(file); }} />
    </div>
    {error ? <p className="materials-error" role="alert">{error}</p> : null}
    <div className="materials-content">
      {legacy ? <CategoryNotePanel key={`legacy-${category}`} ref={panel} problemSetId={setId} category={category} /> : page && (page.kind === 'blank' || preview?.key === page.id) ? <CategoryNotePanel key={`${materialId}-${pageId}`} ref={panel} problemSetId={ownerId} category={annotationCategory(materialId, pageId)} singlePage backgroundUrl={preview?.key === page.id ? preview.url : undefined} pageAspect={preview?.key === page.id ? preview.aspect : undefined} /> : <div className="materials-empty"><p>{page ? 'PDFを読み込み中…' : '資料を見ながら、書き込もう。'}</p>{!page ? <button disabled={!index || busy} onClick={() => fileInput.current?.click()}>PDFを追加</button> : null}<small>1ファイル50MB・500ページまで。PDFは専用の非公開ストレージに同期します。</small></div>}
    </div>
  </section>;
});
