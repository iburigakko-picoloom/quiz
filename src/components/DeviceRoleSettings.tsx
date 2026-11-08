import { useLayoutEffect, useRef, useState } from 'react';
import { useDeviceRole } from '../hooks/useDeviceRole';
import { setDeviceRole } from '../utils/deviceRoleRuntime';

export function DeviceRoleSettings({disabled,onBusyChange}:{disabled:boolean;onBusyChange:(busy:boolean)=>void}) {
  const role=useDeviceRole(), [busy,setBusy]=useState(false), [message,setMessage]=useState(''), [error,setError]=useState('');
  const lock=useRef(false);
  useLayoutEffect(()=>{onBusyChange(busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  return <section className="sync-advanced__section" aria-label="端末の役割"><h2>この端末</h2><div className="sync-actions">{(['main','sub'] as const).map(value=><button type="button" key={value} className={role===value?'sync-button sync-button--primary':'sync-button'} aria-pressed={role===value} disabled={disabled||busy} onClick={()=>{if(value===role||lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');void setDeviceRole(value).then(()=>setMessage(value==='main'?'メイン端末に変更しました':'サブ端末に変更しました')).catch(reason=>setError(reason instanceof Error?reason.message:'端末を切り替えられませんでした')).finally(()=>{lock.current=false;setBusy(false);});}}>{value==='main'?'メイン端末':'サブ端末'}</button>)}</div>{busy?<p role="status">端末を切り替えています…</p>:message?<p role="status">{message}</p>:null}{error?<p role="alert">{error}</p>:null}</section>;
}
