import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppData } from '../types';
import { imageMarkdown } from '../utils/imageAttachment';
import { readImageTarget, SHARE_IMAGE_CACHE } from '../utils/sharedImage';
import './SharedImageReceiver.css';

const errors: Record<string,string> = {
  missing:'画像そのものを共有してください。ページや画像のリンクだけでは追加できません。',
  count:'画像は1枚ずつ共有してください。', type:'PNG・JPEG・WebPの画像を共有してください。',
  size:'10MB以下の画像を共有してください。', full:'未追加の共有画像が残っています。先に追加または閉じてください。',
  storage:'共有画像を受け取れませんでした。写真に保存して「画像を追加」から選んでください。',
};
export function SharedImageReceiver({data,onSave,onClose,onOpenQuestion}: {data:AppData;onSave:(questionId:string,originalQuestion:string,image:string,shareId:string)=>Promise<void>;onClose:()=>void;onOpenQuestion:(questionId:string)=>void}) {
  const [id]=useState(()=>new URL(location.href).searchParams.get('sharedImage')??'');
  const [error,setError]=useState(()=>errors[new URL(location.href).searchParams.get('sharedImageError')??'']??'');
  const [open,setOpen]=useState(()=>Boolean(id||error));
  const [questionId,setQuestionId]=useState(readImageTarget);
  const [image,setImage]=useState(''), [busy,setBusy]=useState(false), [saved,setSaved]=useState(false);
  const lock=useRef(false), dialog=useRef<HTMLDialogElement>(null);
  const question=data.questions.find(q=>q.id===questionId);
  const cacheUrl=()=>new URL(`_shared-image/${id}`,new URL(import.meta.env.BASE_URL,location.href)).href;
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  useEffect(()=>{
    if(!id)return;
    let cancelled=false;
    void (async()=>{
      try {
        if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('共有画像を確認できません。');
        const response=await (await caches.open(SHARE_IMAGE_CACHE)).match(cacheUrl());
        if(!response || Date.now()-Number(response.headers.get('x-quiz-created'))>86_400_000)throw new Error('共有画像の有効期限が切れています。もう一度共有してください。');
        const blob=await response.blob();
        const markdown=await imageMarkdown(new File([blob],'shared-image',{type:blob.type}));
        if(!cancelled)setImage(markdown);
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:errors.storage);}
    })();
    return()=>{cancelled=true;};
  },[id]);
  const close=async()=>{
    if(lock.current)return;
    if(id)try{await(await caches.open(SHARE_IMAGE_CACHE)).delete(cacheUrl());}catch{/* TTL will clear the temporary image. */}
    const url=new URL(location.href);url.searchParams.delete('sharedImage');url.searchParams.delete('sharedImageError');
    history.replaceState(history.state,'',url);setOpen(false);onClose();
  };
  const save=async()=>{
    if(lock.current||!question||!image||saved)return;
    lock.current=true;setBusy(true);setError('');
    try{await onSave(question.id,question.question,image,id);setSaved(true);}
    catch(e){setError(e instanceof Error?e.message:'保存できませんでした。もう一度お試しください。');}
    finally{lock.current=false;setBusy(false);}
  };
  if(!open)return null;
  return createPortal(<dialog ref={dialog} className="shared-image-dialog" onCancel={e=>{e.preventDefault();void close();}}>
    <h2>{saved?'画像を追加しました':'画像を追加'}</h2>
    {image?<img className="shared-image-preview" src={image.slice(image.indexOf('(')+1,-1)} alt="共有された画像"/>:!error?<p role="status">画像を読み込み中…</p>:null}
    {!saved&&image?<label>追加先<select value={question?questionId:''} disabled={busy} onChange={e=>setQuestionId(e.target.value)}>
      <option value="">問題を選ぶ</option>{data.problemSets.map(set=><optgroup label={set.title} key={set.id}>{data.questions.filter(q=>q.setId===set.id).map(q=><option key={q.id} value={q.id}>{q.question.slice(0,100)}</option>)}</optgroup>)}
    </select></label>:null}
    {question?<p className="shared-image-question">{question.question}</p>:null}
    {error?<p role="alert" className="shared-image-error">{error}</p>:null}
    <div className="shared-image-actions"><button disabled={busy} onClick={()=>void close()}>{saved?'閉じる':'キャンセル'}</button>{!saved&&image?<button className="shared-image-save" disabled={busy||!question} onClick={()=>void save()}>{busy?'保存中…':'この問題に追加'}</button>:null}{saved&&question?<button className="shared-image-save" onClick={()=>void close().then(()=>onOpenQuestion(question.id))}>解説を見る</button>:null}</div>
  </dialog>,document.body);
}
