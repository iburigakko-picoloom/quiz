import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { imageReferenceLabel, localImageReferenceStore, referencePoint, validateReferenceImage, type MaterialImageReference } from '../utils/materialImageReferences';
import './MaterialImageReferences.css';

const MOVE_HOLD_MS = 450;
const MOVE_TOLERANCE_PX = 8;
type MarkerGesture = { pointerId: number; startX: number; startY: number; item: MaterialImageReference; target: HTMLButtonElement; timer: ReturnType<typeof setTimeout>; moving: boolean; position: { x: number; y: number } };

export function useMaterialImageReferences(page: string | undefined, disabled: boolean) {
  const store=useMemo(()=>localImageReferenceStore(),[page]);
  const [items,setItems]=useState<MaterialImageReference[]>([]);
  const [ready,setReady]=useState(false), [pending,setPending]=useState<Blob|null>(null), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [selected,setSelected]=useState<MaterialImageReference|null>(null), [url,setUrl]=useState('');
  const input=useRef<HTMLInputElement>(null), alive=useRef(true), locked=useRef(false), focusReturn=useRef<HTMLElement|null>(null), close=useRef<HTMLButtonElement>(null);
  const start=useRef<{x:number;y:number;id:number}|null>(null);
  const gesture=useRef<MarkerGesture|null>(null), suppressClick=useRef(false);
  const [moving,setMoving]=useState<{id:string;x:number;y:number}|null>(null);
  useEffect(()=>{ alive.current=true; setItems([]); setReady(false); setSelected(null); setPending(null);
    if(page) void store.load(page).then(rows=>{if(alive.current){setItems(rows);setReady(true);}},()=>{if(alive.current)setError('画像参照を読み込めません。資料を開き直してください。');});
    return()=>{alive.current=false;if(gesture.current)clearTimeout(gesture.current.timer);gesture.current=null;};
  },[page,store]);
  useEffect(()=>{ if(!selected)return; const value=URL.createObjectURL(selected.image);setUrl(value);close.current?.focus();
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setSelected(null);focusReturn.current?.focus();}};
    window.addEventListener('keydown',escape);
    return()=>{URL.revokeObjectURL(value);window.removeEventListener('keydown',escape);};
  },[selected]);
  const dismiss=()=>{setSelected(null);focusReturn.current?.focus();};
  async function choose(file: File) {
    try { validateReferenceImage(file); const image=new Image(), value=URL.createObjectURL(file);
      try { image.src=value; await image.decode(); if(image.naturalWidth*image.naturalHeight>40_000_000) throw new Error('画像が大きすぎます。小さくして選び直してください。'); } finally { URL.revokeObjectURL(value); }
      if(alive.current){setPending(file);setError('');}
    } catch(e){if(alive.current)setError(e instanceof Error?e.message:'画像を開けませんでした。');}
  }
  const cancelMove=()=>{if(gesture.current)clearTimeout(gesture.current.timer);gesture.current=null;setMoving(null);};
  const startMove=(event:ReactPointerEvent<HTMLButtonElement>,item:MaterialImageReference)=>{
    event.stopPropagation();
    if(!event.isPrimary || event.button!==0 || disabled || busy || locked.current)return;
    suppressClick.current=false;
    const state:MarkerGesture={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,item,target:event.currentTarget,
      timer:setTimeout(()=>{if(gesture.current===state){state.moving=true;suppressClick.current=true;setMoving({id:item.id,x:item.x,y:item.y});}},MOVE_HOLD_MS),
      moving:false,position:{x:item.x,y:item.y}};
    gesture.current=state;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const updateMove=(event:ReactPointerEvent<HTMLButtonElement>)=>{
    event.stopPropagation();
    const state=gesture.current;
    if(!state || state.pointerId!==event.pointerId)return;
    const dx=event.clientX-state.startX,dy=event.clientY-state.startY;
    if(!state.moving){if(Math.hypot(dx,dy)>MOVE_TOLERANCE_PX){suppressClick.current=true;cancelMove();}return;}
    const rect=state.target.parentElement?.getBoundingClientRect();
    if(!rect || !rect.width || !rect.height)return;
    state.position=referencePoint(rect.left+state.item.x*rect.width+dx,rect.top+state.item.y*rect.height+dy,rect);
    setMoving({id:state.item.id,...state.position});
  };
  const finishMove=(event:ReactPointerEvent<HTMLButtonElement>)=>{
    event.stopPropagation();
    const state=gesture.current;
    if(!state || state.pointerId!==event.pointerId)return;
    clearTimeout(state.timer);gesture.current=null;
    if(!state.moving){setMoving(null);return;}
    suppressClick.current=true;
    if(!page || (state.position.x===state.item.x && state.position.y===state.item.y)){setMoving(null);return;}
    locked.current=true;setBusy(true);
    void store.move(page,state.item.id,state.position.x,state.position.y).then(item=>{
      if(alive.current){setItems(old=>old.map(current=>current.id===item.id?item:current));setError('');}
    },()=>{if(alive.current)setError('位置を保存できませんでした。もう一度お試しください。');})
      .finally(()=>{locked.current=false;if(alive.current){setBusy(false);setMoving(null);}});
  };
  if(!page)return {toolbar:null,overlay:null,sheet:null};
  const unavailable=disabled||!ready||busy;
  const sheetContainer=input.current?.closest('.materials-panel');
  return {
    toolbar:<><button type="button" className="category-note-icon-button" aria-label="参照画像を追加" title="参照画像を追加" disabled={unavailable} onClick={()=>input.current?.click()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4H4v16h16V10M4 16l5-5 5 5 3-3 3 3M18 2v8m-4-4h8"/><circle cx="8" cy="8" r="1"/></svg></button><input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="参照画像ファイル" onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void choose(file);}}/></>,
    overlay:<div className="material-image-marks">{items.map(item=>{const position=moving?.id===item.id?moving:item;return <button type="button" key={item.id} className={`material-image-mark${moving?.id===item.id?' material-image-mark--moving':''}`} style={{left:`${position.x*100}%`,top:`${position.y*100}%`}} disabled={disabled||busy} aria-label={`参照画像${item.number}を開く`} onContextMenu={event=>event.preventDefault()} onPointerDown={event=>startMove(event,item)} onPointerMove={updateMove} onPointerUp={finishMove} onPointerCancel={event=>{event.stopPropagation();if(gesture.current?.pointerId===event.pointerId)cancelMove();}} onLostPointerCapture={event=>{if(gesture.current?.pointerId===event.pointerId)cancelMove();}} onClick={event=>{event.stopPropagation();if(suppressClick.current){suppressClick.current=false;return;}focusReturn.current=event.currentTarget;setSelected(item);}}><span>{imageReferenceLabel(item.number)}</span></button>;})}
      {pending?<div className="material-image-placement" aria-label="画像マークの配置位置" onPointerDown={event=>{event.stopPropagation();start.current={x:event.clientX,y:event.clientY,id:event.pointerId};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerCancel={()=>{start.current=null;}} onPointerUp={event=>{
        event.stopPropagation();const point=start.current;start.current=null;
        if(!point||point.id!==event.pointerId||Math.hypot(event.clientX-point.x,event.clientY-point.y)>10||unavailable||locked.current)return;
        const position=referencePoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect());locked.current=true;setBusy(true);
        void store.add(page,pending,position.x,position.y).then(item=>{if(alive.current){setItems(old=>[...old,item]);setPending(null);setError('');}},()=>{if(alive.current)setError('保存できませんでした。空き容量を確認してもう一度配置してください。');}).finally(()=>{locked.current=false;if(alive.current)setBusy(false);});
      }}/> :null}</div>,
    sheet:<>{pending||error?<div className="material-image-status" role="status">{error|| (busy?'画像を保存中…':'画像を置く位置をタップ')}<button type="button" disabled={busy} onClick={()=>{setPending(null);setError('');}}>閉じる</button></div>:null}{selected&&sheetContainer?createPortal(<section className="material-image-sheet" role="dialog" aria-label={`参照画像${selected.number}`}><header><strong>{imageReferenceLabel(selected.number)} 参照画像</strong><button ref={close} type="button" onClick={dismiss} aria-label="参照画像を閉じる">閉じる</button></header>{url?<img src={url} alt={`参照画像${selected.number}`} />:null}</section>,sheetContainer):null}</>,
  };
}
