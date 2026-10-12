import type {AppData} from '../types';
import type {CloudProblemSet} from './cloudService';
import type {GroupFolderCardData} from './groupLibrary';
import {planPublicImport} from './publicImport';

/** Group identity and child placement are distinct from public catalog folders. */
export function planGroupImport(data:AppData, folder:GroupFolderCardData, sets:CloudProblemSet[], groupId:string, timestamp?:string) {
  const paths=new Map<string,{id:string;name:string}[]>();
  const visit=(node:GroupFolderCardData,path:{id:string;name:string}[])=>{
    node.sets.forEach(set=>paths.set(set.id,path));
    node.children.forEach(child=>visit(child,[...path,{id:child.key,name:child.name}]));
  };
  visit(folder,[]);
  if(sets.length!==paths.size||new Set(sets.map(s=>s.id)).size!==sets.length||sets.some(s=>!paths.has(s.id)))throw new Error('フォルダ内の教材が変更されています。もう一度取り込んでください。');
  return planPublicImport(data,sets.map(set=>({...set,standalonePublic:false,tags:[],memberPath:paths.get(set.id)??[]})),{
    groupFolder:{groupId,key:folder.key,name:folder.name},
  },timestamp);
}
