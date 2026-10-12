import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CommunityScreen} from '../../src/screens/CommunityScreen';
import {PublicDiscoveryScreen} from '../../src/screens/PublicDiscoveryScreen';
import {PrimaryBottomNav} from '../../src/components/PrimaryBottomNav';
import type {AppData} from '../../src/types';
import '../../src/index.css';import '../../src/ui-spec.css';import '../../src/final-reference.css';import '../../src/group-ui.css';
const data:AppData={version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]};
function Preview(){
  const [view,setView]=useState('home');
  return <>{view==='discover'?<PublicDiscoveryScreen data={data} onBack={()=>setView('home')} onMine={()=>{}} onFolder={()=>{}} onSet={()=>{}} onLogin={()=>{}} onPublished={async()=>{}} onImport={async()=>{throw Error('unused');}} onOpenLocalSet={()=>{}}/>:view==='groups'?<CommunityScreen data={data} initialTab="groups" onGroupPage={()=>{}} onBack={()=>setView('home')} onManageShares={()=>{}} onCreateProblemSet={()=>{}} onOpenGroup={()=>{}} onOpenLocalSet={()=>{}} onCopySharedSet={async()=>null} onPracticeSharedSet={()=>{}} onPublished={async()=>{}} onUnpublished={async()=>{}}/>:<p>ホーム</p>}<PrimaryBottomNav active={view==='groups'?'groups':view==='discover'?'discover':'home'} onSelect={setView}/></>;
}
createRoot(document.getElementById('root')!).render(import.meta.env.VITE_SUPABASE_URL==='https://list-preview.example.test'?<Preview/>:<p>隔離テスト専用</p>);
