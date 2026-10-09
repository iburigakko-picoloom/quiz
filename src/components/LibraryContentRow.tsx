import type {ReactNode} from 'react';
import {ChevronRightIcon,FolderOutlineIcon,ProblemSetIcon} from './UiIcons';
import '../library-interactions.css';

/** Home's compact icon / title / counts / chevron pattern for folder contents. */
export function LibraryContentRow({title,folder=false,questions,sets,subtitle,disabled,onOpen,actions}:{title:string;folder?:boolean;questions:number;sets?:number;subtitle?:string;disabled?:boolean;onOpen:()=>void;actions?:ReactNode}){
  return <article className="library-content-row"><button type="button" className="library-content-row__open library-tappable" disabled={disabled} onClick={onOpen}>
    <span className="library-content-row__icon" aria-hidden="true">{folder?<FolderOutlineIcon size={34}/>:<ProblemSetIcon size={30}/>}</span>
    <span className="library-content-row__body"><strong>{title}</strong><span>{sets===undefined?'':`${sets.toLocaleString('ja-JP')}セット · `}{questions.toLocaleString('ja-JP')}問{subtitle?` · ${subtitle}`:''}</span></span>
    <ChevronRightIcon size={20}/>
  </button>{actions}</article>;
}
