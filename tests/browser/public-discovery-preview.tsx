import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PublicDiscoveryScreen} from '../../src/screens/PublicDiscoveryScreen';
import {PrimaryBottomNav} from '../../src/components/PrimaryBottomNav';
import {planPublicImport} from '../../src/utils/publicImport';
import type {AppData} from '../../src/types';
import '../../src/index.css';import '../../src/ui-spec.css';import '../../src/final-reference.css';import '../../src/group-ui.css';
const time='2026-10-08T00:00:00Z';
const seed:AppData={version:1,folders:[{id:'local-root',name:'自分の教材',createdAt:time,updatedAt:time},{id:'local-child',name:'子フォルダ',parentFolderId:'local-root',createdAt:time,updatedAt:time}],problemSets:[{id:'local-set',folderId:'local-child',title:'公開用セット',audience:'CBT',subject:'医学',source:'',description:'復習用',createdAt:time,updatedAt:time}],questions:[{id:'local-q',setId:'local-set',question:'確認問題',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'',category:'医学',difficulty:'basic',createdAt:time,updatedAt:time}],progress:[],answerLogs:[]};
type Route={mine?:boolean;folderId?:string;setId?:string};
function Preview(){const [data,setData]=useState(seed),[routes,setRoutes]=useState<Route[]>([{}]);const route=routes.at(-1)!;return <><PublicDiscoveryScreen {...route} data={data} onBack={()=>setRoutes(rows=>rows.slice(0,-1).length?rows.slice(0,-1):[{}])} onMine={()=>setRoutes(rows=>[...rows,{mine:true}])} onFolder={id=>setRoutes(rows=>[...rows,{folderId:id,mine:route.mine}])} onSet={id=>setRoutes(rows=>[...rows,{setId:id,mine:route.mine}])} onLogin={()=>{}} onPublished={async(id,result)=>setData(current=>({...current,problemSets:current.problemSets.map(set=>set.id===id?{...set,cloudSetId:result.id,visibility:result.visibility}:set)}))} onImport={async(sets,options)=>{const result=planPublicImport(data,sets,options);setData(result.data);document.body.dataset.importCount=String(result.data.problemSets.filter(set=>set.creationMethod==='public-copy').length);return result;}} onOpenLocalSet={id=>{document.body.dataset.openedSet=id;}}/><PrimaryBottomNav active="discover" onSelect={()=>{}}/></>;}
createRoot(document.getElementById('root')!).render(import.meta.env.VITE_SUPABASE_URL==='https://public-preview.example.test'?<Preview/>:<p>隔離した検証専用画面です。</p>);
