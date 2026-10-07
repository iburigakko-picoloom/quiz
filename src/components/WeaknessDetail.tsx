import { useEffect, useRef, useState } from 'react';
import { useAccountWork } from '../hooks/useAccountWork';
import { isAccountWorkReloadApproved } from '../utils/accountWork';
import { PinchImage } from './PinchImage';
import { ActionMenu } from './ActionMenu';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { changeWeaknessNotes, readWeaknessNotes, NOTES_EVENT, type WeaknessNote } from '../utils/weaknessNotes';
import { WeaknessMemoList } from './WeaknessMemoList';
import { MemoComposer } from './MemoComposer';
import './WeaknessNotes.css';
import { activateImageTarget, rememberImageTarget } from '../utils/sharedImage';
import { extractExplanationMedia, normalizeExplanationMarkdown } from '../utils/explanationMarkdown';
import { loadLocalQuestionImages, type LocalQuestionImage } from '../utils/localQuestionImages';
export { extractExplanationMedia } from '../utils/explanationMarkdown';

const safeUrl = (url: string) => /^(https?:|mailto:|#)/i.test(url) || /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(url) ? url : '';
function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    img: ({ src, alt }) => src ? <PinchImage src={src} alt={alt ?? ''} /> : <span>{alt}</span>,
    table: ({ children }) => <div className="weakness-table" data-no-page-swipe><table>{children}</table></div>,
    strong: ({ children }) => <strong className="weakness-keyword">{children}</strong>,
    pre: ({ children }) => <div className="weakness-code-block">{children}</div>,
    code: ({ className, children }) => className === 'language-flow'
      ? <div className="weakness-flow" aria-label="フローチャート">{String(children).trim().split('\n').filter(line => line.trim()).map((line, i) => <div className="weakness-flow-row" key={i}>{line.split(/\s*→\s*/).map((step, j) => <span className="weakness-flow-step" key={j}>{j > 0 ? <span aria-hidden="true">→ </span> : null}{step}</span>)}</div>)}</div>
      : <code className={className}>{children}</code>,
  }}>{normalizeExplanationMarkdown(text)}</ReactMarkdown>;
}
export function ExplanationReader({ text, questionId = '', imageIds = [], onSave, onAddImage, onRemoveImage, disabled = false }: {
  text: string; questionId?: string; imageIds?: string[]; onSave?: (body: string) => Promise<void>;
  onAddImage?: (file: File) => Promise<void>; onRemoveImage?: (imageId: string) => Promise<void>; disabled?: boolean;
}) {
  const { media, body } = extractExplanationMedia(text);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [localImages, setLocalImages] = useState<LocalQuestionImage[]>([]);
  const input = useRef<HTMLInputElement>(null), lock = useRef(false);
  useAccountWork(`image-attachment:${questionId}`,()=>null,async()=>{if(lock.current)throw new Error('画像の保存完了を待っています。');});
  useEffect(() => {
    if (!questionId || !imageIds.length) { setLocalImages([]); return; }
    let cancelled = false;
    void loadLocalQuestionImages(questionId, imageIds).then(images => {
      if (!cancelled) { setLocalImages(images); setError(''); }
    }).catch(() => {
      if (!cancelled) setError('端末内の画像を読み込めませんでした。');
    });
    return () => { cancelled = true; };
  }, [questionId, imageIds.join('|')]);
  const attach = async (file: File) => {
    if (!onAddImage || disabled || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await onAddImage(file);
    } catch (e) { setError(e instanceof Error ? e.message : '画像を保存できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const removeImage = async (imageId: string) => {
    if (!onRemoveImage || disabled || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await onRemoveImage(imageId); }
    catch (e) { setError(e instanceof Error ? e.message : '画像を削除できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const pasteImage = async () => {
    if (!onAddImage || disabled || lock.current) return;
    try {
      if (!navigator.clipboard?.read) throw new Error('画像を写真に保存して「画像を追加」から選んでください。');
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t=>/^image\/(png|jpeg|webp|heic|heif)$/.test(t));
        if (type) { await attach(new File([await item.getType(type)], 'clipboard-image', {type})); return; }
      }
      throw new Error('画像をコピーしてから押してください。リンクでは追加できません。');
    } catch (e) { setError(e instanceof Error && e.name !== 'NotAllowedError' ? e.message : '貼り付けを許可するか、写真に保存して「画像を追加」から選んでください。'); }
  };
  const remove = async () => {
    if (!onSave || disabled || lock.current || (!text.trim() && !imageIds.length) || !window.confirm('追加解説・メモと添付画像を削除しますか？通常の解説と苦手メモは残ります。')) return;
    lock.current = true; setBusy(true); setError('');
    try { await onSave(''); }
    catch { setError('削除できませんでした。もう一度お試しください。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="weakness-reader">
    {onSave && !disabled && (text.trim() || imageIds.length) ? <ActionMenu className="weakness-reader-menu"><summary aria-label="追加解説・メモの操作">…</summary><button type="button" disabled={busy} onClick={()=>void remove()}>追加解説・メモを削除</button></ActionMenu> : null}
    {media.length || imageIds.length ? <div className="weakness-media" data-no-page-swipe aria-label="画像・表を横スクロール">
      {media.map((m, i) => <section className={`weakness-media-card${m.startsWith('![') ? ' weakness-media-card--image' : ''}`} key={`media-${i}`}><Markdown text={m} /></section>)}
      {imageIds.map((imageId, index) => {
        const image = localImages.find(item => item.id === imageId);
        return <section className="weakness-media-card weakness-media-card--local-image" key={imageId}>
          {image ? <LocalQuestionImageView image={image} /> : <p>この写真は追加した端末に保存されています。この端末には画像本体がありません。</p>}
          {onRemoveImage && onSave && !disabled ? <button type="button" className="weakness-local-image-remove" disabled={busy} onClick={() => void removeImage(imageId)} aria-label={`添付画像${index + 1}を削除`}>画像を削除</button> : null}
        </section>;
      })}
    </div> : null}
    {body.trim() ? <div className="weakness-markdown"><Markdown text={body} /></div> : null}
    {onAddImage && !disabled ? <div className="weakness-image-actions">
      <button type="button" className="weakness-button" data-no-page-swipe disabled={busy} onClick={() => input.current?.click()}>{busy ? '保存中…' : '画像を追加'}</button>
      <button type="button" className="weakness-button" data-no-page-swipe disabled={busy} onClick={()=>void pasteImage()}>画像を貼り付け</button>
      <small>写真はこの端末に保存され、クラウド同期・バックアップには含まれません。1枚50MBまで。</small>
    </div> : null}
    <input ref={input} type="file" accept="image/*" hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void attach(f);}}/>
    {error ? <p role="alert" className="weakness-error">{error}</p> : null}
  </div>;
}

function LocalQuestionImageView({ image }: { image: LocalQuestionImage }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(image.blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [image.blob]);
  return src ? <PinchImage src={src} alt={image.name || '添付画像'} /> : <p role="status">画像を読み込み中…</p>;
}

export function WeaknessDetail({ questionId, text, imageIds, onSave, onAddImage, onRemoveImage, disabled = false, onDirtyChange, active = true, guideExample, onMemoDeleted }: {
  questionId: string; text: string; imageIds?: string[]; onSave: (body:string)=>Promise<void>; onAddImage?: (file: File)=>Promise<void>;
  onRemoveImage?: (imageId: string)=>Promise<void>; disabled?:boolean; onDirtyChange?:(dirty:boolean)=>void; active?:boolean;
  guideExample?: string; onMemoDeleted?: (id: string) => void;
}) {
  const [savedNotes, setSavedNotes] = useState<WeaknessNote[]>([]);
  const [body, setBody] = useState(''), [memoId, setMemoId] = useState(''), [error, setError] = useState(''), [message,setMessage]=useState('');
  const [adding,setAdding]=useState(!text.trim());
  const failed = useRef(false);
  const writeSequence = useRef(0);
  const saveLock = useRef(false);
  const [savingMemo, setSavingMemo] = useState(false);
  useAccountWork(`weakness-memo:${questionId}`,()=>({body,memoId,adding}),async()=>{if(failed.current||saveLock.current)throw new Error('メモの保存完了を待っています。');});
  const addImage = async (file: File) => {
    if (!onAddImage) return;
    onDirtyChange?.(true);
    try { await onAddImage(file); }
    finally { onDirtyChange?.(false); }
  };
  const removeImage = async (imageId: string) => {
    if (!onRemoveImage) return;
    onDirtyChange?.(true);
    try { await onRemoveImage(imageId); }
    finally { onDirtyChange?.(false); }
  };
  useEffect(() => {
    if (!active || disabled || guideExample !== undefined) return;
    const load = () => { try { setSavedNotes(readWeaknessNotes().filter(note => note.questionId === questionId && !note.draft && note.body.trim())); } catch { setSavedNotes([]); setError('保存したメモを読み込めませんでした。'); } };
    load(); window.addEventListener(NOTES_EVENT, load); window.addEventListener('storage', load);
    return () => { window.removeEventListener(NOTES_EVENT, load); window.removeEventListener('storage', load); };
  }, [questionId, active, disabled, guideExample]);
  useEffect(()=>{
    if (!active || disabled || guideExample !== undefined) return;
    const deactivate = activateImageTarget(questionId);
    const remember=()=>{if(document.visibilityState==='visible')rememberImageTarget(questionId);};
    remember(); document.addEventListener('visibilitychange',remember);
    return()=>{deactivate();document.removeEventListener('visibilitychange',remember);};
  },[questionId,active,disabled,guideExample]);
  useEffect(()=>{
    if (guideExample !== undefined) { setBody(guideExample); setMemoId('guide-only'); return; }
    try { const draft=readWeaknessNotes().find(n=>n.questionId===questionId&&n.draft);setBody(draft?.body??'');setMemoId(draft?.id??crypto.randomUUID());if(draft)setAdding(true); }
    catch {setError('メモを読み込めません。再読み込みしてください。');}
  },[questionId,guideExample]);
  useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
  useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(failed.current&&!isAccountWorkReloadApproved()){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
  const persist=async(value:string,draft:boolean)=>{
    if (guideExample !== undefined) return true;
    const sequence = ++writeSequence.current;
    try {
      failed.current=true;onDirtyChange?.(true);
      await changeWeaknessNotes(notes=>{const old=notes.find(n=>n.id===memoId);const next={...old,id:memoId,title:'問題への疑問',body:value,questionId,draft};return old?notes.map(n=>n.id===memoId?next:n):[next,...notes];});
      if(sequence===writeSequence.current){failed.current=false;onDirtyChange?.(false);setError('');}return true;
    }catch{if(sequence===writeSequence.current){failed.current=true;onDirtyChange?.(true);setError('メモを保存できません。入力内容を残しています。');}return false;}
  };
  const save=async()=>{if(!body.trim()||!memoId||saveLock.current)return;saveLock.current=true;setSavingMemo(true);try{if(await persist(body,false)){setBody('');setMemoId(crypto.randomUUID());setMessage('苦手メモに保存しました');if(text.trim())setAdding(false);}}finally{saveLock.current=false;setSavingMemo(false);}};
  return <section className="weakness-detail">
    <ExplanationReader questionId={questionId} text={text} imageIds={imageIds} onSave={onSave} onAddImage={onAddImage ? addImage : undefined} onRemoveImage={onRemoveImage ? removeImage : undefined} disabled={disabled || guideExample !== undefined}/>
    {!disabled && guideExample === undefined && <WeaknessMemoList notes={savedNotes} disabled={savingMemo} onDeleted={onMemoDeleted}/>}
    {disabled ? (!text.trim()?<p className="weakness-muted">自分の問題にコピーすると疑問を保存できます。</p>:null) : <>
      {!adding&&text.trim()?<button type="button" className="weakness-button" onClick={()=>setAdding(true)}>＋ 追加で質問・メモ</button>:<MemoComposer id={`memo-${questionId}`} value={body} disabled={savingMemo} canSave={Boolean(body.trim() && memoId)} onChange={value=>{setBody(value);setMessage('');if(memoId)void persist(value,true);}} onSave={() => void save()} />}
    </>}
    {message?<p role="status" className="weakness-muted">{message}</p>:null}
    {error?<div role="alert" className="weakness-error">{error}<button type="button" onClick={()=>persist(body,true)}>再保存</button></div>:null}
  </section>;
}
