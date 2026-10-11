import {useState} from 'react';
import type {AppData} from '../types';
import {ChevronRightIcon,FolderOutlineIcon} from './UiIcons';
import {LibraryPane} from './LibraryPane';
import {folderChoices,folderSubtreeIds} from '../utils/folderHierarchy';

export function PublicFolderPicker({data,value,disabled,onChange}:{data:AppData;value:string;disabled:boolean;onChange:(id:string)=>void}) {
  const [query,setQuery]=useState('');
  const [currentId,setCurrentId]=useState('');
  const ordered=folderChoices(data.folders);
  const orderedIds=new Set(ordered.map(folder=>folder.id));
  const folders=[...ordered,...data.folders.filter(folder=>!orderedIds.has(folder.id))];
  const byId=new Map(data.folders.map(folder=>[folder.id,folder]));
  const questionCounts=new Map<string,number>();
  for(const question of data.questions) questionCounts.set(question.setId,(questionCounts.get(question.setId)??0)+1);
  const rows=folders.map(folder=>{
    const path:string[]=[],seen=new Set([folder.id]);
    let parent=folder.parentFolderId?byId.get(folder.parentFolderId):undefined;
    while(parent&&!seen.has(parent.id)) {path.unshift(parent.name);seen.add(parent.id);parent=parent.parentFolderId?byId.get(parent.parentFolderId):undefined;}
    const subtree=folderSubtreeIds(data.folders,folder.id);
    const sets=data.problemSets.filter(set=>subtree.has(set.folderId));
    return {folder,path:path.join(' / '),sets:sets.length,questions:sets.reduce((count,set)=>count+(questionCounts.get(set.id)??0),0),children:subtree.size>1};
  });
  const current=rows.find(row=>row.folder.id===currentId);
  const searching=Boolean(query.trim());
  const visible=rows.filter(row=>searching?`${row.path} ${row.folder.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()):current?row.folder.id===currentId||row.folder.parentFolderId===currentId:!row.folder.parentFolderId||!byId.has(row.folder.parentFolderId));
  const selected=rows.find(row=>row.folder.id===value);
  return <fieldset className="public-folder-picker" disabled={disabled}>
    <legend>公開するフォルダ</legend>
    {folders.length>6?<input type="search" aria-label="公開するフォルダを検索" placeholder="フォルダ名で検索" value={query} onChange={event=>setQuery(event.target.value)}/>:null}
    {current&&!searching?<nav className="public-folder-location" aria-label="公開フォルダの選択位置"><button type="button" onClick={()=>setCurrentId(current.folder.parentFolderId??'')}>‹ 戻る</button><span>{[current.path,current.folder.name].filter(Boolean).join(' / ')}</span></nav>:null}
    <LibraryPane viewKey={searching?`search:${query}`:currentId} depth={current?current.path.split(' / ').filter(Boolean).length+1:0}>
    <div className="public-folder-options">
      {visible.map(({folder,path,sets,questions,children})=><div key={folder.id} className={`public-folder-option${!searching&&current&&folder.id!==currentId?' public-folder-option--child':''}`}><label className={`public-folder-choice${value===folder.id?' is-selected':''}${!sets?' is-empty':''}`}>
        <span className="public-folder-choice__icon" aria-hidden="true"><FolderOutlineIcon size={28}/></span>
        <span className="public-folder-choice__text">{path&&searching?<span>{path}</span>:null}<strong>{folder.name}</strong><span>{sets?`${sets}セット · ${questions.toLocaleString('ja-JP')}問`:'問題セットがありません'}</span></span>
        <input type="radio" name="public-folder-choice" value={folder.id} checked={value===folder.id} disabled={!sets} onChange={()=>onChange(folder.id)}/>
      </label>{children?<button type="button" className="public-folder-explore" aria-label={`${folder.name}の子フォルダを見る`} onClick={()=>{setQuery('');setCurrentId(folder.id);}} disabled={folder.id===currentId}>中を見る<ChevronRightIcon size={17}/></button>:null}</div>)}
    </div>
    </LibraryPane>
    {!visible.length?<p>{folders.length?'該当するフォルダはありません。':'公開できるフォルダはありません。'}</p>:null}
    {selected?.children?<p className="public-folder-selection-note">子フォルダの問題セットもまとめて公開します。</p>:null}
  </fieldset>;
}
