import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useEffect,useRef} from 'react';
import {registerTransientDialog} from '../utils/transientDialog';
export function PublicDialog({title,busy=false,onClose,children}:{title:string;busy?:boolean;onClose:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.querySelector<HTMLElement>('button,input,select')?.focus();return()=>previous?.focus();},[]);
  useEffect(()=>registerTransientDialog(()=>{if(!busy)onClose();}),[busy,onClose]);
  return createPortal(<div className="public-dialog-backdrop" onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="public-dialog" onKeyDown={event=>{
      if(event.key==='Escape'&&!busy)onClose();
      if(event.key==='Tab'){
        const buttons=ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)');
        if(buttons?.length){const first=buttons[0],last=buttons[buttons.length-1];
          if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();}
          else if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();}
        }
      }
    }}><header><h2>{title}</h2><button type="button" disabled={busy} aria-label={`${title}を閉じる`} onClick={onClose}>×</button></header>{children}</div>
  </div>,document.body);
}
