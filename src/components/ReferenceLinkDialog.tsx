import { useEffect, useMemo, useRef, useState } from 'react';
import type { Question } from '../types';
import { loadMaterials } from '../utils/materialStorage';
import type { StudyMaterial } from '../utils/materialModel';
import { referenceCandidates, type ReferenceLink } from '../utils/referenceLinking';

export function ReferenceLinkDialog({ setIds, questions, initialMaterialId, onSave, onClose }: { setIds: string[]; questions: Question[]; initialMaterialId?: string; onSave: (links: ReferenceLink[]) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [materials, setMaterials] = useState<StudyMaterial[]>([]), [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0), [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const material = materials.find(m => m.id === selected);
  const rows = useMemo(() => material ? referenceCandidates(questions, material, offset) : [], [questions, material, offset]);
  const questionNumbers = useMemo(() => new Map(questions.map((question, index) => [question.id, index + 1])), [questions]);
  useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.showModal(); return () => previous?.focus?.(); }, []);
  useEffect(() => { let cancelled = false; void Promise.all(setIds.map(loadMaterials)).then(indexes => { if (!cancelled) setMaterials([...new Map(indexes.flatMap(i => i.materials).filter(m => m.pages.some(p => p.kind === 'pdf')).map(m => [m.id, m])).values()]); }).catch(() => { if (!cancelled) setError('資料を読み込めませんでした。開き直してください。'); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [setIds.join('|')]);
  useEffect(() => {
    if (loading || materials.some(m => m.id === selected)) return;
    const named = materials.filter(m => questions.some(q => q.sourcePage?.normalize('NFKC').includes(m.title.normalize('NFKC'))));
    const match = materials.find(m => m.id === initialMaterialId) ?? (materials.length === 1 ? materials[0] : named.length === 1 ? named[0] : undefined);
    setSelected(match?.id ?? '');
  }, [materials, selected, questions, initialMaterialId, loading]);
  useEffect(() => { setChecked(new Set(rows.filter(r => r.page).map(r => r.question.id))); }, [rows]);
  const selectedRows = rows.filter(r => r.page && checked.has(r.question.id));
  const availableRows = rows.filter(r => r.page);
  const save = async () => { if (!material || busy || !selectedRows.length) return; setBusy(true); setError(''); try { await onSave(selectedRows.map(r => ({ questionId: r.question.id, sourcePage: r.question.sourcePage ?? '', reference: { materialId: material.id, pageId: r.page!.id }, references: r.pages.map(p => ({ materialId: material.id, pageId: p.id })) }))); onClose(); } catch (e) { setError(e instanceof Error ? e.message : '保存できませんでした'); } finally { setBusy(false); } };
  return <dialog ref={dialog} className="reference-link-dialog" aria-labelledby="reference-link-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="reference-link-title">参照ページの設定</h2><button autoFocus disabled={busy} onClick={onClose} aria-label="閉じる">×</button></header>
    <div className="reference-link-body">
      {loading ? <p role="status">読み込み中…</p> : materials.length === 1 ? <div className="reference-link-material"><small>資料</small><strong>{materials[0].title}</strong></div> : materials.length > 1 ? <label>資料<select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}>{!material ? <option value="" disabled hidden>資料を選ぶ</option> : null}{materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label> : !error ? <p>PDFを追加してから設定できます。</p> : null}
      {material && <>
      {rows.length > 0 ? <div className="reference-link-selection"><strong>登録する問題</strong>{availableRows.length > 0 ? <button disabled={busy} onClick={() => setChecked(selectedRows.length === availableRows.length ? new Set() : new Set(availableRows.map(r => r.question.id)))}>{selectedRows.length === availableRows.length ? '選択を解除' : 'すべて選択'}</button> : null}</div> : null}
      {rows.map((row) => <label className="reference-link-row" key={row.question.id}><input type="checkbox" disabled={busy || !row.page} checked={checked.has(row.question.id)} onChange={e => setChecked(old => { const next = new Set(old); if (e.target.checked) next.add(row.question.id); else next.delete(row.question.id); return next; })}/><span><strong>{questionNumbers.get(row.question.id)}. {row.question.question}</strong><small className={row.page ? 'reference-link-pages' : ''}>{row.page ? row.pages.map(p => `p${p.pdfPage}`).join('・') : row.reason}</small></span></label>)}
      {!rows.length ? <p>参照ページはすべて登録済みです。</p> : <details className="reference-link-adjust"><summary>ページのずれを調整{offset !== 0 ? `（${offset > 0 ? '+' : ''}${offset}）` : ''}</summary><label>ページのずれ<input type="number" min="-500" max="500" value={offset} disabled={busy} onChange={e => setOffset(Math.max(-500, Math.min(500, Number(e.target.value) || 0)))} /></label><small>記載のp1がPDFのp3なら「2」</small></details>}</>}
      {error && <p role="alert">{error}</p>}
    </div><footer>{!loading && ((!materials.length && !error) || (material && !rows.length)) ? <button onClick={onClose}>閉じる</button> : <button disabled={busy || !selectedRows.length} onClick={() => void save()}>{busy ? '保存中…' : selectedRows.length ? `${selectedRows.length}問を登録` : '登録する'}</button>}</footer>
  </dialog>;
}
