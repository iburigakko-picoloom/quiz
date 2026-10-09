import type {ReactNode} from 'react';
import type {PublicFolder,PublicSet} from '../utils/publicLibrary';
import {FolderOutlineIcon,ProblemSetIcon,GroupIcon,ChevronRightIcon} from './UiIcons';
import '../library-interactions.css';

export function LibraryTags({tags,limit}:{tags:string[];limit?:number}){
  const visible=[...new Set(tags.filter(Boolean))];
  return <span className="public-tags">{visible.slice(0,limit).map(tag=><span key={tag}>{tag}</span>)}</span>;
}
export function LibraryArtwork({folder=false}:{folder?:boolean}){
  return <span className="public-artwork">{folder?<FolderOutlineIcon size={45}/>:<ProblemSetIcon size={40}/>}</span>;
}
export function LibraryCounts({questions,people,sets}:{questions:number;people?:number;sets?:number}){
  return <span className="public-counts">{sets!==undefined?<span>{sets.toLocaleString('ja-JP')}セット</span>:null}<span>{questions.toLocaleString('ja-JP')}問</span>{typeof people==='number'?<span><GroupIcon size={16}/>{people.toLocaleString('ja-JP')}人</span>:null}</span>;
}
export function PublicLibraryRow({item,onOpen,actions,simple=false}:{item:PublicFolder|PublicSet;onOpen:()=>void;actions?:ReactNode;simple?:boolean}){
  const folder='name' in item;
  return <article className="public-library-row">
    <button type="button" className="public-library-row__open library-tappable" onClick={onOpen}>
      <LibraryArtwork folder={folder}/>
      <span className="public-library-row__body">
        <strong>{folder?item.name:item.title}</strong>
        <LibraryCounts questions={item.questionCount} people={simple?undefined:item.importCount} sets={folder?item.setCount:undefined}/>
        {!simple?<LibraryTags tags={folder?[item.category,...item.tags]:item.tags} limit={2}/>:null}
      </span>
      {actions?null:<ChevronRightIcon size={20}/>}
    </button>{actions}
  </article>;
}
