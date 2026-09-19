import { useEffect, useMemo, useRef, useState } from 'react';
import type { Question } from '../types';
import { loadMaterials } from '../utils/materialStorage';
import type { StudyMaterial } from '../utils/materialModel';
import { referenceCandidates, type ReferenceLink } from '../utils/referenceLinking';

export function ReferenceLinkDialog({ setIds, questions, onSave, onClose }: { setIds: string[]; questions: Question[]; onSave: (links: ReferenceLink[]) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [materials, setMaterials] = useState<StudyMaterial[]>([]), [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0), [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const material = materials.find(m => m.id === selected);
  const rows = useMemo(() => material ? referenceCandidates(questions, material, offset) : [], [questions, material, offset]);
  useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.showModal(); return () => previous?.focus?.(); }, []);
  useEffect(() => { let cancelled = false; void Promise.all(setIds.map(loadMaterials)).then(indexes => { if (!cancelled) setMaterials([...new Map(indexes.flatMap(i => i.materials).filter(m => m.pages.some(p => p.kind === 'pdf')).map(m => [m.id, m])).values()]); }).catch(() => { if (!cancelled) setError('資料を読み込めませんでした。開き直してください。'); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [setIds.join('|')]);
  useEffect(() => { setChecked(new Set()); }, [selected, offset]);
  const save = async () => { if (!material || busy) return; setBusy(true); setError(''); try { await onSave(rows.filter(r => r.page && checked.has(r.question.id)).map(r => ({ questionId: r.question.id, sourcePage: r.question.sourcePage ?? '', reference: { materialId: material.id, pageId: r.page!.id } }))); onClose(); } catch (e) { setError(e instanceof Error ? e.message : '保存できませんでした'); } finally { setBusy(false); } };
  return <dialog ref={dialog} className="reference-link-dialog" aria-labelledby="reference-link-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="reference-link-title">Referenceをまとめて紐付け</h2><button disabled={busy} onClick={onClose} aria-label="閉じる">×</button></header>
    <div className="reference-link-body">
      <p>Referenceに書かれた資料と同じPDFを選んでください。登録済みの紐付けは変更しません。</p>
      <label>資料<select disabled={busy || loading} value={selected} onChange={e => setSelected(e.target.value)}><option value="">{loading ? '読込中…' : 'PDFを選択'}</option>{materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
      {!loading && !materials.length && <p>先に資料の「PDFを追加」から登録してください。</p>}
      {material && <><label>ページのずれ<input type="number" min="-500" max="500" value={offset} disabled={busy} onChange={e => setOffset(Math.max(-500, Math.min(500, Number(e.target.value) || 0)))} /></label><small>例：Referenceの1ページがPDFの3ページなら「2」。白紙を追加した位置ではなく、元のPDFのページです。</small>
      <button disabled={busy} onClick={() => setChecked(new Set(rows.filter(r => r.page).map(r => r.question.id)))}>候補をすべて選択</button>
      {rows.map((row, i) => <label className="reference-link-row" key={row.question.id}><input type="checkbox" disabled={busy || !row.page} checked={checked.has(row.question.id)} onChange={e => setChecked(old => { const next = new Set(old); if (e.target.checked) next.add(row.question.id); else next.delete(row.question.id); return next; })}/><span><strong>{i + 1}. {row.question.question}</strong><small>{row.question.sourcePage || 'Referenceなし'} → {row.page ? `PDF ${row.page.pdfPage}p` : row.reason}</small></span></label>)}
      {!rows.length && <p>未登録の問題はありません。</p>}</>}
      {error && <p role="alert">{error}</p>}
    </div><footer><button disabled={busy || !checked.size} onClick={() => void save()}>{busy ? '保存中…' : `${checked.size}問を紐付ける`}</button></footer>
  </dialog>;
}
