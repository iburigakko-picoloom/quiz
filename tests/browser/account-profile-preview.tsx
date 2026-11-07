import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsScreen} from '../../src/screens/SettingsScreen';
import {AccountSyncScreen} from '../../src/screens/AccountSyncScreen';
import '../../src/index.css';
function Preview(){const [view,setView]=React.useState<'account'|'sync'>('account');return <><nav><button onClick={()=>setView('account')}>設定画面</button><button onClick={()=>setView('sync')}>同期画面</button></nav>{view==='account'?<SettingsScreen page="account" onNavigate={()=>{}} onBack={()=>{}} onExport={()=>{}} onImportBackup={async()=>null} onClearAll={async()=>false} onOpenSync={()=>setView('sync')} onOpenSyncSettings={()=>{}} onOpenPrivacy={()=>{}} onOpenGuide={()=>{}}/>:<AccountSyncScreen onBack={()=>setView('account')}/>}</>}
if(import.meta.env.DEV&&import.meta.env.VITE_SUPABASE_URL==='https://profile-preview.example.test')createRoot(document.getElementById('root')!).render(<Preview/>);
