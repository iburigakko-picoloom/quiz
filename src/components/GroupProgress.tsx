import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { groupProgressRpc, onCloudAuthStateChange, type CloudProblemSet } from '../utils/cloudService';
import { commonVersionProgress, parseGroupProgress, type GroupProgressSnapshot } from '../utils/groupProgress';
import '../screens/PlansScreen.css';

export function GroupProgress({ data, groupId, set, userId, onClose }: { data: AppData; groupId: string; set: CloudProblemSet; userId: string; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<GroupProgressSnapshot | null>(null);
  const [copyId, setCopyId] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const alive = useRef(true); const action = useRef(false);
  const copies = data.problemSets.filter(s => s.sourceSetId === set.id && s.sourceVersionId === set.versionId && Boolean(commonVersionProgress(data, s, set.id, set.versionId ?? '')));
  const read = async () => {
    const result = parseGroupProgress(await groupProgressRpc('quiz_group_progress_read', { p_group_id: groupId, p_set_id: set.id }, userId));
    if (!alive.current) return null;
    setSnapshot(result); setCopyId(result.own.copy_id ?? ''); return result;
  };
  useEffect(() => {
    alive.current = true;
    void read().catch(reason => { if (alive.current) setError(reason instanceof Error ? reason.message : '共有進捗を読み込めません。'); });
    const stop = onCloudAuthStateChange((_event, session) => { if (session?.user.id !== userId) { alive.current = false; setSnapshot(null); setError('アカウントが変更されています。画面を閉じてください。'); } });
    return () => { alive.current = false; stop(); };
  }, [groupId, set.id, userId]);
  const run = async (operation: () => Promise<void>) => {
    if (action.current) return; action.current = true; setBusy(true); setError('');
    try { await operation(); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '反映できません。'); }
    finally { action.current = false; if (alive.current) setBusy(false); }
  };
  const reflect = async (current: GroupProgressSnapshot, chosen: string) => {
    const local = data.problemSets.find(s => s.id === chosen);
    const aggregate = local && set.versionId ? commonVersionProgress(data, local, set.id, set.versionId) : null;
    if (!aggregate || !current.own.enabled || !current.own.generation) throw new Error('取込み済みの同じ公開版を選択してください。');
    await groupProgressRpc('quiz_group_progress_update', { p_group_id: groupId, p_set_id: set.id, p_generation: current.own.generation, p_copy_id: chosen, p_version_id: set.versionId, p_answered: aggregate.answered }, userId);
    await read();
  };
  const consent = async (enabled: boolean) => {
    const current = snapshot;
    if (!current || !alive.current) return;
    await groupProgressRpc('quiz_group_progress_consent', { p_group_id: groupId, p_set_id: set.id, p_enabled: enabled, p_copy_id: enabled ? copyId : null, p_version_id: enabled ? set.versionId : null, p_expected_generation: current.own.generation }, userId);
    const fresh = await read();
    if (enabled && fresh) await reflect(fresh, copyId);
  };
  return <section className="plans-screen group-progress" aria-label="みんなの進捗"><div className="plans-body">
    <div className="plan-actions"><h2>みんなの進捗</h2><button onClick={onClose}>閉じる</button></div><p>{set.title} · {set.versionId ? `公開版 ${set.versionId.slice(0, 8)}` : '公開版の準備待ち'}</p>
    <p className="plan-muted">共有を選んだ現在のメンバーの、同じ公開版の集計だけを表示します。</p>
    {error ? <p role="alert" className="plan-warning">{error}</p> : null}
    <section className="plan-card"><h2>自分の共有</h2><p>{snapshot?.own.enabled ? '共有ON' : '共有OFF'}</p><p className="plan-muted">共有するのは回答済み問題数・対象数・割合・最終反映です。個人計画や回答内容は送信しません。</p>
      {!copies.length ? <p>{data.problemSets.some(s => s.sourceSetId === set.id) ? '同じ公開版の取込み待ちです。古いコピーの由来は文章から推測しません。' : '未取込です。教材を取り込むと共有するコピーを選べます。'}</p> : <label>共有するコピー（1つ）<select aria-label="共有するコピー" disabled={busy || snapshot?.own.enabled} value={copyId} onChange={e => setCopyId(e.target.value)}><option value="">選択してください</option>{copies.map(s => <option key={s.id} value={s.id}>{s.title} / {data.folders.find(f => f.id === s.folderId)?.name}</option>)}</select></label>}
      <div className="plan-actions">{snapshot?.own.enabled ? <><button disabled={busy} onClick={() => void run(() => consent(false))}>共有をOFFにする</button><button disabled={busy || !copies.some(s => s.id === copyId)} onClick={() => void run(async () => { const fresh = await read(); if (fresh) await reflect(fresh, fresh.own.copy_id ?? ''); })}>自分の進捗を反映</button></> : <button disabled={busy || !snapshot || !copies.some(s => s.id === copyId) || !set.versionId} onClick={() => void run(() => consent(true))}>このコピーの集計を共有する</button>}<button disabled={busy} onClick={() => void run(async () => { await read(); })}>再読み込み</button></div>
    </section>
    {snapshot?.members.map(member => <article className="plan-card" key={member.user_id}><strong>{member.display_name}{member.user_id === userId ? '（自分）' : ''}</strong>{member.state === 'shared' ? <><p>{member.answered}/{member.total}問 · {Math.round(member.answered! / member.total! * 100)}%</p><progress value={member.answered!} max={member.total!} aria-label={`${member.display_name} 回答済み`} /><p className="plan-muted">最終反映 {new Date(member.reflected_at!).toLocaleString('ja-JP')}</p></> : <p className="plan-muted">{{ not_shared: '未共有', update_pending: '公開版の更新待ち', reflection_pending: '進捗の反映待ち' }[member.state]}</p>}</article>)}
  </div></section>;
}
