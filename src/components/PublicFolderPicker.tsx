import {useState} from 'react';
import type {AppData} from '../types';
import {FolderOutlineIcon} from './UiIcons';
import {folderChoices,folderSubtreeIds} from '../utils/folderHierarchy';

export function PublicFolderPicker({data,value,disabled,onChange}:{data:AppData;value:string;disabled:boolean;onChange:(id:string)=>void}) {
  const [query,setQuery]=useState('');
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
  const visible=rows.filter(row=>`${row.path} ${row.folder.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected=rows.find(row=>row.folder.id===value);
  return <fieldset className="public-folder-picker" disabled={disabled}>
    <legend>公開するフォルダ</legend>
    {folders.length>6?<input type="search" aria-label="公開するフォルダを検索" placeholder="フォルダ名で検索" value={query} onChange={event=>setQuery(event.target.value)}/>:null}
    <div className="public-folder-options">
      {visible.map(({folder,path,sets,questions})=><label key={folder.id} className={`public-folder-choice${value===folder.id?' is-selected':''}${!sets?' is-empty':''}`}>
        <span className="public-folder-choice__icon" aria-hidden="true"><FolderOutlineIcon size={28}/></span>
        <span className="public-folder-choice__text">{path?<span>{path}</span>:null}<strong>{folder.name}</strong><span>{sets?`${sets}セット · ${questions.toLocaleString('ja-JP')}問`:'問題セットがありません'}</span></span>
        <input type="radio" name="public-folder-choice" value={folder.id} checked={value===folder.id} disabled={!sets} onChange={()=>onChange(folder.id)}/>
      </label>)}
    </div>
    {!visible.length?<p>{folders.length?'該当するフォルダはありません。':'公開できるフォルダはありません。'}</p>:null}
    {selected?.children?<p className="public-folder-selection-note">子フォルダの問題セットもまとめて公開します。</p>:null}
  </fieldset>;
}
