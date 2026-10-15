import { useEffect, useRef, useState } from 'react';
import { readStorageBreakdown, type StorageBreakdownRow } from '../utils/storageBreakdown';
export function StorageBreakdown() {
  const [rows,setRows]=useState<StorageBreakdownRow[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const controller=useRef<AbortController|null>(null);
  const [stage,setStage]=useState(''),[complete,setComplete]=useState(false);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const read=async()=>{setBusy(true);setError('');setRows(null);setComplete(false);const active=new AbortController();controller.current=active;try{setRows(await readStorageBreakdown({signal:active.signal,onProgress:(value,label)=>{setRows(value);setStage(label);}}));setComplete(true);}catch(e){setError(e instanceof Error?e.message:'保存容量を確認できません。');}finally{setBusy(false);}};
  return <section className="sync-section" aria-label="保存容量の内訳"><h3>保存容量の内訳</h3><div>
    <button type="button" className="sync-button" disabled={busy} onClick={()=>void read()}>{busy?'集計中…':'内訳を確認'}</button>
    {busy?<><button type="button" className="sync-button" onClick={()=>controller.current?.abort()}>中止</button><p role="status">{stage?`${stage}を集計中…`:'保存先を確認中…'}</p></>:null}
    {error?<p role="alert">{error}</p>:null}
    {rows?<><p className="sync-help">{complete?'集計完了。':'集計途中の値です。'}現在のアカウントの保存データ量（概算）。複製を含みます。ブラウザの実使用量とは異なり、キャッシュ・他アカウントは含みません。</p><ul>{rows.map((row,i)=><li key={i}>{row.label}：{(row.bytes/1048576).toFixed(1)} MB（{row.count}件）</li>)}</ul></>:null}
  </div></section>;
}
