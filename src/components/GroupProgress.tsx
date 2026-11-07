import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { groupProgressRpc, onCloudAuthStateChange, type CloudProblemSet } from '../utils/cloudService';
import { commonVersionProgress, type GroupProgressSnapshot } from '../utils/groupProgress';
import { importedLearning, levelPercentages, sumLevels } from '../utils/groupLearning';
import { groupStudyCandidates } from '../utils/groupStudySource';
import { parseLearningSet, type MaterialProgress, type LearningSetSnapshot } from '../utils/groupLearningService';
import { GroupEmpty, ImportedMemberProgress, LevelProgress } from './GroupLearningUi';
import { watchGroupProgress } from '../utils/groupReflectionQueue';
import { GroupMaterialHistory } from './GroupMaterialHistory';

export function GroupProgress({ data, groupId, set, userId, onClose, onChanged, summary }: { data: AppData; groupId: string; set: CloudProblemSet; userId: string; summary?: MaterialProgress; onClose?: () => void; onChanged?: () => void }) {
  const [snapshot, setSnapshot] = useState<LearningSetSnapshot | null>(null);
  const [copyId, setCopyId] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const alive = useRef(true); const action = useRef(false);
  const copies = groupStudyCandidates(data,set,userId).filter(s=>Boolean(commonVersionProgress(data,s,set.id,set.versionId??'')));
  const candidatesKey = copies.map(s => s.id).join('|');
  useEffect(() => watchGroupProgress(() => {
    if (!alive.current || action.current) return;
    void run(async () => { await read(); });
  }), [groupId, set.id, set.versionId, userId, candidatesKey]);
  const read = async () => {
    const result = parseLearningSet(await groupProgressRpc('quiz_group_learning_set_read', { p_group_id: groupId, p_set_id: set.id }, userId));
    if (!alive.current) return null;
    if (result.version_id !== set.versionId) throw new Error('公開版が更新されています。一覧を再読み込みして開き直してください。');
    setSnapshot(result); setCopyId(copies.some(copy=>copy.id===result.own.copy_id) ? result.own.copy_id! : (copies[0]?.id??'')); return result;
  };
  useEffect(() => {
    alive.current = true;
    void run(async () => {
      let current = await read();
      const chosen = current?.own.copy_id ?? copies[0]?.id;
      if (!current || !chosen || !set.versionId || !copies.some(s => s.id === chosen)) return;
      if (current?.own.enabled && current.own.version_id === set.versionId) await reflect(current, chosen);
    });
    const stop = onCloudAuthStateChange((_event, session) => { if (session?.user.id !== userId) { alive.current = false; setSnapshot(null); setError('アカウントが変更されています。画面を閉じてください。'); } });
    return () => { alive.current = false; stop(); };
  }, [groupId, set.id, set.versionId, userId, candidatesKey]);
  const run = async (operation: () => Promise<void>) => {
    if (action.current) return; action.current = true; setBusy(true); setError('');
    try { await operation(); } catch (reason) { if (alive.current) { setSnapshot(null); setError(reason instanceof Error ? reason.message : '反映できません。'); } }
    finally { action.current = false; if (alive.current) setBusy(false); }
  };
  const reflect = async (current: GroupProgressSnapshot, chosen: string) => {
    const local = copies.find(s => s.id === chosen);
    const aggregate = local && set.versionId ? importedLearning(data, local, set.id, set.versionId) : null;
    if (!aggregate || !current.own.enabled || !current.own.generation) throw new Error('同じ公開版の共有元または取り込み済み教材を選択してください。');
    await groupProgressRpc('quiz_group_learning_update', { p_group_id: groupId, p_set_id: set.id, p_generation: current.own.generation, p_copy_id: chosen, p_version_id: set.versionId, p_answered: aggregate.answered, p_levels: aggregate.levels, p_today: aggregate.todayCount, p_week: aggregate.weekCount, p_day: aggregate.day, p_week_start: aggregate.weekStart }, userId);
    await read();
    onChanged?.();
  };
  const consent = async (enabled: boolean) => {
    const current = snapshot;
    if (!current || !alive.current) return;
    await groupProgressRpc('quiz_group_progress_consent', { p_group_id: groupId, p_set_id: set.id, p_enabled: enabled, p_copy_id: enabled ? copyId : null, p_version_id: enabled ? set.versionId : null, p_expected_generation: current.own.generation }, userId);
    const fresh = await read();
    if (enabled && fresh) await reflect(fresh, copyId);
    onChanged?.();
  };
  const visibleMembers = snapshot?.members.filter(member => member.state === 'shared') ?? [];
  const local = copies.find(copy => copy.id === copyId);
  const own = local && set.versionId ? importedLearning(data, local, set.id, set.versionId) : null;
  const shared = visibleMembers;
  const answered = shared.length && shared.every(m=>m.answered!==null) ? shared.reduce((n,m)=>n+m.answered!,0) : null;
  const total = shared.length && shared.every(m=>m.total!==null) ? shared.reduce((n,m)=>n+m.total!,0) : null;
  const levels = shared.length && shared.every(m=>m.levels) ? sumLevels(shared.flatMap(m=>m.levels?[m.levels]:[])) : null;
  const currentSummary = summary?.versionId === set.versionId ? summary : undefined;
  return <section className="group-panel group-set-progress" aria-label="メンバーの進捗">
    <div className="group-panel__heading"><h2>教材の進捗</h2>{onClose ? <button type="button" className="group-text-link" onClick={onClose}>閉じる</button> : null}</div>
    {error ? <p role="alert" className="group-error">{error}</p> : null}
    <h3>自分の進捗</h3>
    {copies.length > 1 ? <label>自分の教材<select value={copyId} onChange={event=>setCopyId(event.target.value)}>{copies.map(copy=><option key={copy.id} value={copy.id}>{copy.title}</option>)}</select></label> : null}
    <div className="group-own-progress-metrics"><p>回答済み <strong>{own?.answered ?? '—'}</strong> / {own?.total ?? '—'}問</p><p>Level 3 <strong>{own?.total && own.levels ? `${levelPercentages(own.levels)[3]}%` : '—'}</strong></p></div>
    {own?.levels ? <LevelProgress levels={own.levels} label="自分の理解度" /> : <GroupEmpty>現在の公開版で確認できる進捗はありません。</GroupEmpty>}
    <h3>今日・今週の学習状況</h3>
    <p>今日：{own?.todayCount ?? '未反映'} ／ 今週：{own?.weekCount ?? '未反映'}</p>

    <h3>メンバーの進捗</h3>
    <ImportedMemberProgress members={(snapshot?.members ?? []).map(member => ({ userId: member.user_id, self: member.user_id === userId, name: member.user_id === userId ? 'あなた' : member.display_name, levels: member.state === 'shared' ? member.levels : null, reflectedAt: member.state === 'shared' ? member.reflected_at : null, status: member.state === 'shared' ? '反映待ち' : { not_shared: '未共有', update_pending: '更新待ち', reflection_pending: '反映待ち' }[member.state] }))} />
    {snapshot && !snapshot.members.length ? <GroupEmpty>メンバーの進捗はまだありません。</GroupEmpty> : !snapshot && !error ? <p role="status" className="group-muted">進捗を読み込み中…</p> : null}
    <details><summary>グループ全体</summary><p>回答済み {answered ?? '—'} / {total ?? '—'}問・回答率 {total && answered !== null ? `${Math.round(answered/total*100)}%` : '—'}</p>{levels ? <LevelProgress levels={levels} label="グループ全体の理解度" /> : null}<p>今日：{currentSummary?.todayCount ?? '未反映'} ／ 今週：{currentSummary?.weekCount ?? '未反映'}</p></details>
    <h3>この教材の学習記録</h3>{set.versionId ? <GroupMaterialHistory groupId={groupId} setId={set.id} versionId={set.versionId} userId={userId}/> : <p>教材の公開版を確認できません。</p>}
    <h3>進捗の共有設定</h3>
    <p>回答済み問題数・理解度・解答回数をこのグループに共有します。</p>
    <div className="group-sharing-toggle">
      <span>進捗を共有</span>
      <button type="button" role="switch" aria-label="進捗を共有" aria-checked={snapshot?.own.enabled ?? false} disabled={busy || !snapshot || (!snapshot.own.enabled && (!copyId || !set.versionId))} onClick={() => void run(() => consent(!snapshot?.own.enabled))}>
        <span className="group-sharing-toggle__track" aria-hidden="true"><span /></span>
        <span>{snapshot?.own.enabled ? 'ON' : 'OFF'}</span>
      </button>
    </div>
    {snapshot?.own.enabled && copyId && (snapshot.own.copy_id !== copyId || snapshot.own.version_id !== set.versionId) ? <button type="button" className="group-secondary" disabled={busy} onClick={()=>void run(()=>consent(true))}>選択した教材・公開版に共有を切り替える</button> : null}
    {error ? <button type="button" className="group-text-link" disabled={busy} onClick={() => void run(async () => { const fresh = await read(); if (fresh?.own.enabled && fresh.own.copy_id) await reflect(fresh, fresh.own.copy_id); })}>再試行</button> : null}
  </section>;
}
