import { useEffect, useMemo, useRef, useState } from 'react';
import type { Question } from '../types';
import { loadMaterials } from '../utils/materialStorage';
import type { StudyMaterial } from '../utils/materialModel';
import { referenceCandidates, type ReferenceLink } from '../utils/referenceLinking';

export function ReferenceLinkDialog({ setId, questions, initialMaterialId, initialPageId, onSave, onClose }: { setId: string; questions: Question[]; initialMaterialId?: string; initialPageId?: string; onSave: (links: ReferenceLink[]) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [materials, setMaterials] = useState<StudyMaterial[]>([]), [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0), [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [mode,setMode]=useState<'source'|'page'|'replace'|'remove'>(initialPageId?'page':'source'),[manualPageId,setManualPageId]=useState(initialPageId??'');
  const [includeRegistered, setIncludeRegistered] = useState(false);
  const material = materials.find(m => m.id === selected);
  useEffect(()=>{if(material&&!material.pages.some(p=>p.id===manualPageId))setManualPageId(material.pages[0]?.id??'');},[material,manualPageId]);
  const rows = useMemo(() => {
    if(!material)return [];
    if(mode==='source')return referenceCandidates(questions,material,offset,includeRegistered);
    const page=material.pages.find(p=>p.id===manualPageId);
    if(mode==='replace'||mode==='remove')return questions.filter(q=>q.materialReferences?.some(r=>r.materialId===material.id)).map(question=>({question,page,pages:mode==='remove'?[]:page?[page]:[],reason:''}));
    return questions.map(question=>{const linked=question.materialReferences?.some(r=>r.materialId===material.id&&r.pageId===page?.id);return {question,page:linked?undefined:page,pages:page&&!linked?[page]:[],reason:linked?'このページは登録済みです':'ページを選んでください'};});
  }, [questions, material, offset, mode, manualPageId, includeRegistered]);
  const questionNumbers = useMemo(() => new Map(questions.map((question, index) => [question.id, index + 1])), [questions]);
  useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.showModal(); return () => previous?.focus?.(); }, []);
  useEffect(() => { let cancelled = false; setLoading(true); setMaterials([]); setSelected(''); void loadMaterials(setId).then(index => { if (!cancelled) setMaterials(index.materials.filter(m => m.pages.length)); }).catch(() => { if (!cancelled) setError('資料を読み込めませんでした。開き直してください。'); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [setId]);
  useEffect(() => {
    if (loading || materials.some(m => m.id === selected)) return;
    const named = materials.filter(m => questions.some(q => q.sourcePage?.normalize('NFKC').includes(m.title.normalize('NFKC'))));
    const match = materials.find(m => m.id === initialMaterialId) ?? (materials.length === 1 ? materials[0] : named.length === 1 ? named[0] : undefined);
    setSelected(match?.id ?? '');
  }, [materials, selected, questions, initialMaterialId, loading]);
  // Do not reset a user's selections on an unrelated answer/progress rerender.
  const candidatesKey=JSON.stringify(rows.map(r=>[r.question.id,r.pages.map(p=>p.id)]));
  useEffect(() => { setChecked(new Set(mode==='source'?rows.filter(r => r.page).map(r => r.question.id):[])); }, [candidatesKey,mode]);
  const selectedRows = rows.filter(r => r.page && checked.has(r.question.id));
  const availableRows = rows.filter(r => r.page);
  const save = async () => { if (!material || busy || !selectedRows.length) return; setBusy(true); setError(''); try { await onSave(selectedRows.map(r => ({ questionId: r.question.id, sourcePage: r.question.sourcePage ?? '', reference: { materialId: material.id, pageId: r.page!.id }, references: r.pages.map(p => ({ materialId: material.id, pageId: p.id })),...(mode==='page'?{append:true}:mode==='replace'||mode==='remove'||includeRegistered?{replaceMaterialId:material.id,expectedReferences:r.question.materialReferences??[]}:{}) }))); onClose(); } catch (e) { setError(e instanceof Error ? e.message : '保存できませんでした'); } finally { setBusy(false); } };
  return <dialog ref={dialog} className="reference-link-dialog" aria-labelledby="reference-link-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="reference-link-title">参照ページの設定</h2><button autoFocus disabled={busy} onClick={onClose} aria-label="閉じる">×</button></header>
    <div className="reference-link-body">
      {loading ? <p role="status">読み込み中…</p> : materials.length === 1 ? <div className="reference-link-material"><small>この問題セットの資料</small><strong>{materials[0].title}</strong></div> : materials.length > 1 ? <label>この問題セットの資料<select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}>{!material ? <option value="" disabled hidden>資料を選ぶ</option> : null}{materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label> : !error ? <p>この問題セットに資料を追加してから設定できます。</p> : null}
      {material && <>
      <div className="reference-link-selection" role="group" aria-label="参照ページの登録方法"><button disabled={busy} aria-pressed={mode==='source'} onClick={()=>setMode('source')}>記載から登録</button><button disabled={busy} aria-pressed={mode==='page'} onClick={()=>setMode('page')}>ページを選んで追加</button><button disabled={busy} aria-pressed={mode==='replace'} onClick={()=>setMode('replace')}>登録済みを変更</button><button disabled={busy} aria-pressed={mode==='remove'} onClick={()=>setMode('remove')}>参照を解除</button></div>
      {mode==='page'||mode==='replace'?<label>{mode==='replace'?'変更先のページ':'追加するページ'}<select aria-label={mode==='replace'?'変更先のページ':'追加するページ'} disabled={busy} value={manualPageId} onChange={e=>setManualPageId(e.target.value)}>{material.pages.map((p,i)=><option key={p.id} value={p.id}>{p.kind==='pdf'?`PDF p${p.pdfPage}`:`白紙 ${i+1}`}</option>)}</select></label>:mode==='remove'?<p>選んだ問題から、この資料への参照を解除します。問題や解答履歴は残ります。</p>:<><p>記載から判定できないときは「ページを選んで追加」で登録できます。</p><label><input type="checkbox" checked={includeRegistered} disabled={busy} onChange={e=>setIncludeRegistered(e.target.checked)}/>登録済みの参照も再調整する</label></>}
      {mode==='replace'?<p>選んだ問題の、この資料への参照を指定した1ページに置き換えます。</p>:null}
      {rows.length > 0 ? <div className="reference-link-selection"><strong>対象の問題</strong>{availableRows.length > 0 ? <button disabled={busy} onClick={() => setChecked(selectedRows.length === availableRows.length ? new Set() : new Set(availableRows.map(r => r.question.id)))}>{selectedRows.length === availableRows.length ? '選択を解除' : 'すべて選択'}</button> : null}</div> : null}
      {rows.map((row) => <label className="reference-link-row" key={row.question.id}><input type="checkbox" disabled={busy || !row.page} checked={checked.has(row.question.id)} onChange={e => setChecked(old => { const next = new Set(old); if (e.target.checked) next.add(row.question.id); else next.delete(row.question.id); return next; })}/><span><strong>{questionNumbers.get(row.question.id)}. {row.question.question}</strong>{row.question.materialReferences?.some(r=>r.materialId===material.id)?<small>現在：{row.question.materialReferences.filter(r=>r.materialId===material.id).map(r=>{const p=material.pages.find(p=>p.id===r.pageId);return p?.kind==='pdf'?`p${p.pdfPage}`:p?'白紙ページ':'見つからないページ';}).join('・')}</small>:null}<small className={row.page ? 'reference-link-pages' : ''}>{mode==='remove'?'この資料への参照を解除':row.page ? row.pages.map(p => p.kind==='pdf'?`p${p.pdfPage}`:'白紙ページ').join('・') : row.reason}</small></span></label>)}
      {!rows.length ? <p>{mode==='source'?'参照ページはすべて登録済みです。':mode==='page'?'この問題セットに問題がありません。':'この資料を参照する問題はありません。'}</p> : mode==='source'?<details className="reference-link-adjust"><summary>ページのずれを調整{offset !== 0 ? `（${offset > 0 ? '+' : ''}${offset}）` : ''}</summary><label>ページのずれ<input type="number" min="-500" max="500" value={offset} disabled={busy} onChange={e => setOffset(Math.max(-500, Math.min(500, Number(e.target.value) || 0)))} /></label><small>記載のp1がPDFのp3なら「2」</small></details>:null}</>}
      {error && <p role="alert">{error}</p>}
    </div><footer>{!loading && ((!materials.length && !error) || (material && !rows.length)) ? <button onClick={onClose}>閉じる</button> : <button disabled={busy || !selectedRows.length} onClick={() => void save()}>{busy ? '保存中…' : selectedRows.length ? `${selectedRows.length}問を${mode==='remove'?'解除':mode==='replace'||(mode==='source'&&includeRegistered)?'更新':'登録'}` : '問題を選んでください'}</button>}</footer>
  </dialog>;
}
