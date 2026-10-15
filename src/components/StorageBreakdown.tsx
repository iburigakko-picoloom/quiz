import { useState } from 'react';
import { readStorageBreakdown, type StorageBreakdownRow } from '../utils/storageBreakdown';
export function StorageBreakdown() {
  const [rows,setRows]=useState<StorageBreakdownRow[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const read=async()=>{setBusy(true);setError('');setRows(null);try{setRows(await readStorageBreakdown());}catch(e){setError(e instanceof Error?e.message:'保存容量を確認できません。');}finally{setBusy(false);}};
  return <section className="sync-section" aria-label="保存容量の内訳"><h3>保存容量の内訳</h3><div>
    <button type="button" className="sync-button" disabled={busy} onClick={()=>void read()}>{busy?'集計中…':'内訳を確認'}</button>
    {error?<p role="alert">{error}</p>:null}
    {rows?<><p className="sync-help">現在のアカウントの保存データ量（概算）。複製を含みます。ブラウザの実使用量とは異なり、キャッシュ・他アカウントは含みません。</p><ul>{rows.map((row,i)=><li key={i}>{row.label}：{(row.bytes/1048576).toFixed(1)} MB（{row.count}件）</li>)}</ul></>:null}
  </div></section>;
}
