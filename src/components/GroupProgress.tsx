import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { groupProgressRpc, onCloudAuthStateChange, type CloudProblemSet } from '../utils/cloudService';
import { commonVersionProgress, type GroupProgressSnapshot } from '../utils/groupProgress';
import { importedLearning, sumLevels } from '../utils/groupLearning';
import { groupStudyCandidates } from '../utils/groupStudySource';
import { parseLearningSet, type MaterialProgress, type LearningSetSnapshot } from '../utils/groupLearningService';
import { GroupEmpty, ImportedMemberProgress, LevelProgress } from './GroupLearningUi';
import { watchGroupProgress } from '../utils/groupReflectionQueue';

export function GroupProgress({ data, groupId, set, userId, onClose, onChanged, summary }: { data: AppData; groupId: string; set: CloudProblemSet; userId: string; summary?: MaterialProgress; onClose?: () => void; onChanged?: () => void }) {
  const [scope, setScope] = useState<'self' | 'all'>('self');
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
  const answered = scope === 'self' ? own?.answered : shared.length ? shared.reduce((n,m)=>n+(m.answered ?? 0),0) : null;
  const total = scope === 'self' ? own?.total : shared.length ? shared.reduce((n,m)=>n+(m.total ?? 0),0) : null;
  const levels = scope === 'self' ? own?.levels : shared.length && shared.every(m=>m.levels) ? sumLevels(shared.flatMap(m=>m.levels?[m.levels]:[])) : null;
  const currentSummary = summary?.versionId === set.versionId ? summary : undefined;
  return <section className="group-panel group-set-progress" aria-label="メンバーの進捗">
    <div className="group-panel__heading"><h2>教材の進捗</h2>{onClose ? <button type="button" className="group-text-link" onClick={onClose}>閉じる</button> : null}</div>
    {error ? <p role="alert" className="group-error">{error}</p> : null}
    <div className="group-segment" aria-label="進捗の対象">{([['self','自分'],['all','グループ全体']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={scope===value} onClick={()=>setScope(value)}>{label}</button>)}</div>
    {copies.length > 1 ? <label>自分の教材<select value={copyId} onChange={event=>setCopyId(event.target.value)}>{copies.map(copy=><option key={copy.id} value={copy.id}>{copy.title}</option>)}</select></label> : null}
    <p>回答済み {answered ?? '—'} / {total ?? '—'}問・回答率 {total ? `${Math.round((answered ?? 0)/total*100)}%` : '—'}</p>
    {levels ? <LevelProgress levels={levels} label="理解度" /> : <GroupEmpty>現在の公開版で確認できる進捗はありません。</GroupEmpty>}
    <h3>今日・今週の学習状況</h3>
    <p>今日：{(scope==='self' ? own?.todayCount : currentSummary?.todayCount) ?? '未反映'} ／ 今週：{(scope==='self' ? own?.weekCount : currentSummary?.weekCount) ?? '未反映'}（解答回数・日本時間）</p>
    <p className="group-muted">グループ全体は共有中の現在の公開版のみ集計します。未反映は0問として扱いません。</p>
    <h3>メンバー別の学習進捗</h3>
    <ImportedMemberProgress members={visibleMembers.map(member => ({ userId: member.user_id, name: member.user_id === userId ? 'あなた' : member.display_name, levels: member.state === 'shared' ? member.levels : null, reflectedAt: member.reflected_at, status: member.state === 'shared' ? '反映待ち' : { not_shared: '未共有', update_pending: '更新待ち', reflection_pending: '反映待ち' }[member.state] }))} />
    {snapshot && !visibleMembers.length ? <GroupEmpty>共有できる進捗はまだありません。</GroupEmpty> : !snapshot && !error ? <p role="status" className="group-muted">進捗を読み込み中…</p> : null}
    <h3>進捗の共有設定</h3>
    <p className="group-muted">ONにすると回答済み問題数・理解度・解答回数をこのグループに共有します。回答内容は送信しません。</p>
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
