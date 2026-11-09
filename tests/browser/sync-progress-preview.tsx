import React from 'react';
import {createRoot} from 'react-dom/client';
import {SyncProgressView} from '../../src/components/SyncProgressView';
import '../../src/screens/SyncScreen.css';
const root=createRoot(document.getElementById('root')!);
const states={
 sending:{complete:false,step:'push',progress:{stage:'sending',unit:'parts',label:'学習データを送信中',completed:268,total:269}},
 receiving:{complete:false,step:'pull',progress:{stage:'receiving_records',unit:'bytes',label:'学習データを受信中',completed:12582912,total:null}},
 saving:{complete:false,step:'push',progress:{stage:'sending',unit:'parts',label:'クラウドで学習データを保存中',completed:268,total:269}},
 applying:{complete:false,step:'applying',progress:{stage:'applying',label:'受信した学習データを反映中',completed:0,total:1200}},
 auth:{complete:false,step:'authentication'},
 done:{complete:true,step:'done'}
};
(window as any).showProgress=(name:keyof typeof states)=>root.render(<main style={{padding:16,fontFamily:'sans-serif'}}><h1>同期</h1><SyncProgressView {...states[name] as any}/></main>);
(window as any).showProgress('sending');
