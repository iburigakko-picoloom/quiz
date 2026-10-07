import { useEffect, useState } from 'react';
import { openAppDb } from '../storage';
import { readActiveRecordConflicts } from '../utils/recordSyncPull';
import { getRemoteSyncConfig } from '../utils/syncService';

/** Keep legacy staged originals untouched until media verification permits whole sync. */
export function LegacyWholeSyncNotice({syncId,accountId,onOpenBackups}:{syncId:string;accountId:string;onOpenBackups?:()=>void}) {
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => {
    let stopped = false, reading = false;
    setPending(false); setError('');
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const config = getRemoteSyncConfig();
        if (!config) throw new Error();
        const conflicts = await readActiveRecordConflicts(await openAppDb(),{project:new URL(config.url).origin,userId:accountId,syncId});
        if (!stopped) { setPending(conflicts.length > 0); setError(''); }
      } catch { if (!stopped) setError('変更の確認内容を読み込めません。端末のデータを保持しています。'); }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(),5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [syncId,accountId]);
  if (!pending) return error ? <p role="alert">{error}</p> : null;
  return <section className="sync-section" aria-label="全体同期の準備">
    <h2>両方に変更があります</h2>
    <p>画像を含む元データとバックアップの確認後に、使うデータを全体で一度選びます。確認が済むまで両方の原本を保持します。</p>
    {onOpenBackups ? <button type="button" className="sync-button" onClick={onOpenBackups}>バックアップ・復旧</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
