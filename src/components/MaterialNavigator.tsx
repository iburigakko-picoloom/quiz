import { useEffect, useId, useRef, useState } from 'react';
import type { MaterialReference, Question } from '../types';
import type { StudyMaterial } from '../utils/materialModel';
import { normalizedMaterialText, relatedMaterialQuestions, searchMaterialPdf, type MaterialTextResult } from '../utils/materialSearch';

export function MaterialNavigator({ materials, material, ownerId, disabled, onSelect, onPage, onClose }: {
  materials: StudyMaterial[]; material?: StudyMaterial; ownerId: string; disabled: boolean;
  onSelect: (id: string) => void; onPage: (id: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(''), [pdfQuery, setPdfQuery] = useState('');
  const [result, setResult] = useState<MaterialTextResult | null>(null), [error, setError] = useState('');
  const [progress, setProgress] = useState<{done: number; total: number} | null>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const pagesKey = material?.pages.map(page => `${page.id}:${page.pdfPage}`).join('|');
  useEffect(() => {
    request.current?.abort(); setResult(null); setProgress(null); setError('');
    return () => request.current?.abort();
  }, [ownerId, material?.id, pagesKey]);
  const search = async () => {
    if (!material || !pdfQuery.trim()) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setResult(null); setError(''); setProgress({done:0,total:material.pages.filter(page=>page.kind==='pdf').length});
    try {
      const found = await searchMaterialPdf(ownerId, material, pdfQuery, controller.signal, (done,total)=>{
        if (!controller.signal.aborted) setProgress({done,total});
      });
      if (!controller.signal.aborted) setResult(found);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'PDFを検索できませんでした。');
    } finally { if (!controller.signal.aborted) setProgress(null); }
  };
  const filtered = materials.filter(item=>normalizedMaterialText(item.title).includes(normalizedMaterialText(query)));
  return <aside className="materials-navigator" aria-label="資料一覧">
    <header><h2>資料一覧</h2><button type="button" aria-label="資料一覧を閉じる" onClick={onClose}>×</button></header>
    <label htmlFor={`${id}-materials`}>資料を検索</label>
    <input id={`${id}-materials`} type="search" value={query} onChange={event=>setQuery(event.target.value)} />
    <ul className="materials-navigator__list">{filtered.map(item=><li key={item.id}><button type="button" aria-current={material?.id===item.id?'true':undefined} disabled={disabled} onClick={()=>onSelect(item.id)}><strong>{item.title}</strong><span>{item.pages.length}ページ</span></button></li>)}</ul>
    {!filtered.length ? <p role="status">該当する資料がありません</p> : null}
    {material?.pages.some(page=>page.kind==='pdf') ? <form onSubmit={event=>{event.preventDefault();void search();}}>
      <label htmlFor={`${id}-pdf`}>PDF内を検索</label>
      <div className="materials-navigator__search"><input id={`${id}-pdf`} type="search" value={pdfQuery} onChange={event=>setPdfQuery(event.target.value)} /><button type="submit" disabled={!pdfQuery.trim()}>検索</button></div>
      {progress ? <div role="status">検索中 {progress.done} / {progress.total}<button type="button" onClick={()=>{request.current?.abort();setProgress(null);}}>中止</button></div> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result ? <>
        <p role="status">{result.textPages===0 ? '文字を抽出できないPDFです（画像・スキャンなど）' : `${result.matches.length}${result.limited?'件以上':'件'}のページ`}</p>
        {result.textPages>0 && result.imagePages>0 ? <p>文字を抽出できないページ：{result.imagePages}</p> : null}
        <ul className="materials-navigator__results">{result.matches.map(match=><li key={match.pageId}><button type="button" disabled={disabled} onClick={()=>onPage(match.pageId)}><strong>p{match.pageNumber}</strong><span>{match.excerpt}</span></button></li>)}</ul>
      </> : null}
    </form> : null}
  </aside>;
}

export function MaterialRelatedQuestions({questions, materialId, pageId, disabled, onReference}: {
  questions: Question[]; materialId: string; pageId: string; disabled: boolean; onReference: (reference: MaterialReference) => void;
}) {
  const related = relatedMaterialQuestions(questions, materialId, pageId);
  return <section className="materials-related" aria-label="現在のページの関連問題">
    <h2>関連問題 {related.length}問</h2>
    {!related.length ? <p>このページに関連する問題はありません</p> : related.map(question=><article key={question.id}>
      <details><summary>{question.question}</summary><ol>{question.choices.map((choice,index)=><li key={index}>{choice}</li>)}</ol></details>
      <button type="button" disabled={disabled} onClick={()=>onReference({materialId,pageId})}>参照PDFページへ</button>
    </article>)}
  </section>;
}
