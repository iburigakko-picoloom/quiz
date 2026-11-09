import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { MaterialReference, Question } from '../types';
import type { StudyMaterial } from '../utils/materialModel';
import type { MaterialPage } from '../utils/materialModel';
import { MaterialPreviewCache } from '../utils/materialPreview';
import { normalizedMaterialText, relatedMaterialQuestions, searchMaterialPdf, type MaterialTextResult } from '../utils/materialSearch';

export function MaterialNavigator({ materials, material, ownerId, pageId, disabled, onSelect, onPage, children }: {
  materials: StudyMaterial[]; material?: StudyMaterial; ownerId: string; disabled: boolean;
  pageId: string;
  onSelect: (id: string) => void; onPage: (id: string) => void; children?: ReactNode;
}) {
  const [query, setQuery] = useState(''), [pdfQuery, setPdfQuery] = useState('');
  const [tab, setTab] = useState<'questions'|'materials'|'search'>('questions');
  const thumbnails = useRef(new MaterialPreviewCache());
  const [result, setResult] = useState<MaterialTextResult | null>(null), [error, setError] = useState('');
  const [progress, setProgress] = useState<{done: number; total: number} | null>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const pagesKey = material?.pages.map(page => `${page.id}:${page.pdfPage}`).join('|');
  useEffect(() => {
    request.current?.abort(); setResult(null); setProgress(null); setError('');
    return () => request.current?.abort();
  }, [ownerId, material?.id, pagesKey]);
  useEffect(() => () => thumbnails.current.clear(), []);
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
    <div className="materials-navigator__tabs" role="tablist" aria-label="資料パネル">{([['questions','問題'],['materials','資料'],['search','検索']] as const).map(([value,label],index)=><button type="button" role="tab" key={value} aria-selected={tab===value} tabIndex={tab===value?0:-1} onClick={()=>setTab(value)} onKeyDown={event=>{if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;event.preventDefault();const next=(index+(event.key==='ArrowRight'?1:2))%3;const value=(['questions','materials','search'] as const)[next];setTab(value);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();}}>{label}</button>)}</div>
    {tab==='questions' ? <><p>現在のページ：p{(material?.pages.findIndex(page=>page.id===pageId) ?? -1)+1}</p>{children}</> : null}
    {tab==='materials' ? <>
    <label htmlFor={`${id}-materials`}>資料を検索</label>
    <input id={`${id}-materials`} type="search" value={query} onChange={event=>setQuery(event.target.value)} />
    <ul className="materials-navigator__list">{filtered.map(item=><li key={item.id}><button type="button" aria-current={material?.id===item.id?'true':undefined} disabled={disabled} onClick={()=>onSelect(item.id)}><strong>{item.title}</strong><span>{item.pages.length}ページ</span></button></li>)}</ul>
    {!filtered.length ? <p role="status">該当する資料がありません</p> : null}
    </> : null}
    {tab==='materials' && material ? <div className="materials-navigator__pages">{material.pages.map((page,index)=><PageThumbnail key={page.id} cache={thumbnails.current} ownerId={ownerId} materialId={material.id} page={page} number={index+1} active={page.id===pageId} disabled={disabled} onPage={onPage}/>)}</div> : null}
    {tab==='search' && material?.pages.some(page=>page.kind==='pdf') ? <form onSubmit={event=>{event.preventDefault();void search();}}>
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

function PageThumbnail({cache,ownerId,materialId,page,number,active,disabled,onPage}:{cache:MaterialPreviewCache;ownerId:string;materialId:string;page:MaterialPage;number:number;active:boolean;disabled:boolean;onPage:(id:string)=>void}) {
  const ref=useRef<HTMLButtonElement>(null),[url,setUrl]=useState('');
  useEffect(()=>{
    let cancelled=false;setUrl('');const node=ref.current;
    if(!node || page.kind==='blank' || typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(entries=>{if(!entries.some(entry=>entry.isIntersecting))return;observer.disconnect();void cache.loadBackground(ownerId,materialId,page,128).then(result=>{if(!cancelled)setUrl(result.url??'');}).catch(()=>{});},{rootMargin:'150px'});
    observer.observe(node);return()=>{cancelled=true;observer.disconnect();};
  },[cache,ownerId,materialId,page.id,page.kind,page.pdfPage]);
  return <button ref={ref} type="button" className="materials-navigator__page" aria-label={`${number}ページ`} aria-current={active?'page':undefined} disabled={disabled} onClick={()=>onPage(page.id)}>{url?<img src={url} alt=""/>:<span className="materials-navigator__page-placeholder" aria-hidden="true"/>}<span>{number}</span></button>;
}

export function MaterialRelatedQuestions({questions, materialId, pageId, disabled, onReference, onOpenQuestion, inline = false}: {
  questions: Question[]; materialId: string; pageId: string; disabled: boolean; onReference: (reference: MaterialReference) => void; onOpenQuestion?: (questionId:string, reference:MaterialReference)=>void; inline?: boolean;
}) {
  const [query,setQuery]=useState('');
  const related = relatedMaterialQuestions(questions, materialId, pageId);
  const filtered = related.filter(question=>normalizedMaterialText([question.question,...question.choices].join(' ')).includes(normalizedMaterialText(query)));
  return <section className="materials-related" aria-label="現在のページの関連問題">
    <h2>関連問題 {related.length}問</h2>
    {related.length ? <label className="materials-related__search"><span>関連問題を検索</span><input type="search" placeholder="関連問題を検索" value={query} onChange={event=>setQuery(event.target.value)}/></label> : null}
    {!related.length ? <p>このページの関連問題はありません</p> : !filtered.length ? <p>該当する問題はありません</p> : filtered.map(question=><article key={question.id}>
      <details><summary>{question.question}</summary><ol>{question.choices.map((choice,index)=><li key={index}>{choice}</li>)}</ol>{inline ? <div className="materials-related__explanation"><h3>解説</h3><p>{question.explanation}</p><p>{question.detailedExplanation}</p><p>{question.detailedAnswer?.body}</p></div> : null}</details>
      {!inline ? <div className="materials-related__actions">{onOpenQuestion ? <button type="button" disabled={disabled} onClick={()=>onOpenQuestion(question.id,{materialId,pageId})}>問題の詳細へ</button> : null}
      <button type="button" disabled={disabled} onClick={()=>onReference({materialId,pageId})}>参照PDFページへ</button></div> : null}
    </article>)}
  </section>;
}
