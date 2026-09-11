import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { changeWeaknessNotes, readWeaknessNotes } from '../utils/weaknessNotes';
import './WeaknessNotes.css';
import { extractExplanationMedia, normalizeExplanationMarkdown } from '../utils/explanationMarkdown';
export { extractExplanationMedia } from '../utils/explanationMarkdown';

const safeUrl = (url: string) => /^(https?:|mailto:|#)/i.test(url) || /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(url) ? url : '';
function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    img: ({ src, alt }) => src ? <img src={src} alt={alt ?? ''} loading="lazy" /> : <span>{alt}</span>,
    table: ({ children }) => <div className="weakness-table" data-no-page-swipe><table>{children}</table></div>,
    strong: ({ children }) => <strong className="weakness-keyword">{children}</strong>,
    pre: ({ children }) => <div className="weakness-code-block">{children}</div>,
    code: ({ className, children }) => className === 'language-flow'
      ? <div className="weakness-flow" aria-label="フローチャート">{String(children).trim().split('\n').filter(line => line.trim()).map((line, i) => <div className="weakness-flow-row" key={i}>{line.split(/\s*→\s*/).map((step, j) => <span className="weakness-flow-step" key={j}>{j > 0 ? <span aria-hidden="true">→ </span> : null}{step}</span>)}</div>)}</div>
      : <code className={className}>{children}</code>,
  }}>{normalizeExplanationMarkdown(text)}</ReactMarkdown>;
}
async function imageMarkdown(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10_000_000) throw new Error('10MB以下のPNG・JPEG・WebP画像を選んでください。');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('画像を縮小してから選んでください。');
    const canvas = document.createElement('canvas');
    for (const max of [1200, 900, 650]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('画像を読み込めません。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', .75);
      if (data.length < 180_000) return `![添付画像](${data})`;
    }
    throw new Error('画像が大きすぎます。必要な範囲を切り抜いて再度添付してください。');
  } finally { URL.revokeObjectURL(url); }
}
export function ExplanationReader({ text, onSave, disabled = false }: { text: string; onSave?: (body: string) => Promise<void>; disabled?: boolean }) {
  const { media, body } = extractExplanationMedia(text);
  const [active, setActive] = useState<number | null>(null), [tab, setTab] = useState<'table'|'image'>('table');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), lock = useRef(false);
  useEffect(() => { if (active !== null) dialog.current?.showModal(); }, [active]);
  const attach = async (file: File) => {
    if (!onSave || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const image = await imageMarkdown(file); const next = `${text}\n\n${image}`;
      if (next.length > 250_000) throw new Error('画像を含む解説が保存上限を超えます。画像を小さくしてください。');
      await onSave(next);
    } catch (e) { setError(e instanceof Error ? e.message : '画像を保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const matching = media.map((value, i) => ({value, i})).filter(x => tab === 'image' ? x.value.startsWith('![') : !x.value.startsWith('!['));
  return <div className="weakness-reader">
    {media.length ? <div className="weakness-media" data-no-page-swipe aria-label="画像・表を横スクロール">{media.map((m, i) => <button type="button" className="weakness-media-card" key={i} onClick={() => { setTab(m.startsWith('![') ? 'image' : 'table'); setActive(i); }} aria-label={`${m.startsWith('![') ? '画像' : '表'}${i+1}を拡大`}><Markdown text={m} /></button>)}</div> : null}
    {body.trim() ? <div className="weakness-markdown"><Markdown text={body} /></div> : null}
    {onSave && !disabled ? <button type="button" className="weakness-text" disabled={busy} onClick={() => { setTab('image'); setActive(0); }}>画像・表を表示／画像を追加</button> : null}
    {error ? <p role="alert" className="weakness-error">{error}</p> : null}
    {active !== null ? createPortal(<dialog ref={dialog} className="weakness-media-dialog" onCancel={e => { if (busy) e.preventDefault(); else setActive(null); }}>
      <header><button type="button" disabled={busy} onClick={() => setActive(null)}>閉じる</button><h2>比較表・画像</h2></header>
      <div className="weakness-tabs"><button type="button" aria-pressed={tab==='table'} onClick={()=>setTab('table')}>比較表</button><button type="button" aria-pressed={tab==='image'} onClick={()=>setTab('image')}>画像</button></div>
      <div className="weakness-expanded-media">{matching.length ? matching.map(m=><section key={m.i}><Markdown text={m.value}/></section>) : <p>まだありません</p>}</div>
      {onSave && !disabled ? <button type="button" className="weakness-button" disabled={busy} onClick={()=>input.current?.click()}>{busy?'保存中…':'＋ 画像を添付'}</button> : null}
      {error ? <p role="alert" className="weakness-error">{error}</p> : null}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void attach(f);}}/>
    </dialog>, document.body) : null}
  </div>;
}

export function WeaknessDetail({ questionId, text, onSave, disabled = false, onDirtyChange }: { questionId: string; text: string; onSave: (body:string)=>Promise<void>; disabled?:boolean; onDirtyChange?:(dirty:boolean)=>void }) {
  const [body, setBody] = useState(''), [memoId, setMemoId] = useState(''), [error, setError] = useState(''), [message,setMessage]=useState('');
  const [adding,setAdding]=useState(!text.trim());
  const failed = useRef(false);
  useEffect(()=>{
    try { const draft=readWeaknessNotes().find(n=>n.questionId===questionId&&n.draft);setBody(draft?.body??'');setMemoId(draft?.id??crypto.randomUUID());if(draft)setAdding(true); }
    catch {setError('メモを読み込めません。再読み込みしてください。');}
  },[questionId]);
  useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
  useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(failed.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
  const persist=(value:string,draft:boolean)=>{
    try {
      changeWeaknessNotes(notes=>{const old=notes.find(n=>n.id===memoId);const next={...old,id:memoId,title:'問題への疑問',body:value,questionId,draft};return old?notes.map(n=>n.id===memoId?next:n):[next,...notes];});
      failed.current=false;onDirtyChange?.(false);setError('');return true;
    }catch{failed.current=true;onDirtyChange?.(true);setError('メモを保存できません。入力内容を残しています。');return false;}
  };
  const save=()=>{if(!body.trim()||!memoId)return;if(persist(body,false)){setBody('');setMemoId(crypto.randomUUID());setMessage('苦手メモに保存しました');if(text.trim())setAdding(false);}};
  return <section className="weakness-detail">
    {text.trim()?<ExplanationReader text={text} onSave={onSave} disabled={disabled}/>:null}
    {disabled ? (!text.trim()?<p className="weakness-muted">自分の問題にコピーすると疑問を保存できます。</p>:null) : <>
      {!adding&&text.trim()?<button type="button" className="weakness-button" onClick={()=>setAdding(true)}>＋ 追加で質問・メモ</button>:<div className="weakness-composer">
        <label htmlFor={`memo-${questionId}`}>詳しく知りたいこと</label>
        <div className="weakness-compose-row"><textarea id={`memo-${questionId}`} className="answer-sheet__detail-input" value={body} maxLength={4000} onChange={e=>{setBody(e.target.value);setMessage('');if(memoId)persist(e.target.value,true);}}/><button type="button" className="weakness-primary" onClick={save} disabled={!body.trim()||!memoId} aria-label="苦手メモに保存">↑</button></div>
      </div>}
    </>}
    {message?<p role="status" className="weakness-muted">{message}</p>:null}
    {error?<div role="alert" className="weakness-error">{error}<button type="button" onClick={()=>persist(body,true)}>再保存</button></div>:null}
  </section>;
}
