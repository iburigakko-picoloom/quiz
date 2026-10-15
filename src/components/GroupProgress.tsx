import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { groupProgressRpc, onCloudAuthStateChange, type CloudProblemSet } from '../utils/cloudService';
import { commonVersionProgress, type GroupProgressSnapshot } from '../utils/groupProgress';
import { importedLearning } from '../utils/groupLearning';
import { groupStudyCandidates } from '../utils/groupStudySource';
import { parseLearningSet, type LearningSetSnapshot } from '../utils/groupLearningService';
import { GroupEmpty, ImportedMemberProgress } from './GroupLearningUi';
import { watchGroupProgress } from '../utils/groupReflectionQueue';

export function GroupProgress({ data, groupId, set, userId, onClose, onChanged }: { data: AppData; groupId: string; set: CloudProblemSet; userId: string; onClose?: () => void; onChanged?: () => void }) {
  const [snapshot, setSnapshot] = useState<LearningSetSnapshot | null>(null);
  const [copyId, setCopyId] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const alive = useRef(true); const action = useRef(false);
  const copies = groupStudyCandidates(data,set,userId).filter(s=>Boolean(commonVersionProgress(data,s,set.id,set.versionId??'')));
  const candidatesKey = copies.map(s => s.id).join('|');
  useEffect(() => watchGroupProgress(() => {
    if (!alive.current || action.current) return;
    action.current = true;
    void read().catch(() => undefined).finally(() => { action.current = false; });
  }), [groupId, set.id, set.versionId, userId, candidatesKey]);
  const read = async () => {
    const result = parseLearningSet(await groupProgressRpc('quiz_group_learning_set_read', { p_group_id: groupId, p_set_id: set.id }, userId));
    if (!alive.current) return null;
    setSnapshot(result); setCopyId(result.own.copy_id ?? (copies[0]?.id??'')); return result;
  };
  useEffect(() => {
    alive.current = true;
    void run(async () => {
      let current = await read();
      const chosen = current?.own.copy_id ?? copies[0]?.id;
      if (!current || !chosen || !set.versionId || !copies.some(s => s.id === chosen)) return;
      if (!current.own.enabled && current.own.generation === null) {
        await groupProgressRpc('quiz_group_progress_consent', { p_group_id: groupId, p_set_id: set.id, p_enabled: true, p_copy_id: chosen, p_version_id: set.versionId, p_expected_generation: null }, userId);
        current = await read();
      }
      if (current?.own.enabled && current.own.version_id === set.versionId) await reflect(current, chosen);
    });
    const stop = onCloudAuthStateChange((_event, session) => { if (session?.user.id !== userId) { alive.current = false; setSnapshot(null); setError('アカウントが変更されています。画面を閉じてください。'); } });
    return () => { alive.current = false; stop(); };
  }, [groupId, set.id, set.versionId, userId, candidatesKey]);
  const run = async (operation: () => Promise<void>) => {
    if (action.current) return; action.current = true; setBusy(true); setError('');
    try { await operation(); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '反映できません。'); }
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
  const visibleMembers = snapshot?.members.filter(member => member.imported || member.user_id === userId && copies.length > 0) ?? [];
  return <section className="group-panel group-set-progress" aria-label="メンバーの進捗">
    <div className="group-panel__heading"><h2>メンバーの進捗</h2>{onClose ? <button type="button" className="group-text-link" onClick={onClose}>閉じる</button> : null}</div>
    {error ? <p role="alert" className="group-error">{error}</p> : null}
    <ImportedMemberProgress members={visibleMembers.map(member => ({ userId: member.user_id, name: member.user_id === userId ? 'あなた' : member.display_name, levels: member.state === 'shared' ? member.levels : null, reflectedAt: member.reflected_at, status: member.state === 'shared' ? '反映待ち' : { not_shared: '未共有', update_pending: '更新待ち', reflection_pending: '反映待ち' }[member.state] }))} />
    {snapshot && !visibleMembers.length ? <GroupEmpty>共有できる進捗はまだありません。</GroupEmpty> : !snapshot && !error ? <p role="status" className="group-muted">進捗を読み込み中…</p> : null}
    <div className="group-sharing-toggle">
      <span>進捗を共有</span>
      <button type="button" role="switch" aria-label="進捗を共有" aria-checked={snapshot ? snapshot.own.enabled || snapshot.own.generation === null : true} disabled={busy || !snapshot || (!snapshot.own.enabled && snapshot.own.generation !== null && (!copyId || !set.versionId))} onClick={() => void run(() => consent(!(snapshot?.own.enabled || snapshot?.own.generation === null)))}>
        <span className="group-sharing-toggle__track" aria-hidden="true"><span /></span>
        <span>{snapshot && !snapshot.own.enabled && snapshot.own.generation !== null ? 'OFF' : 'ON'}</span>
      </button>
    </div>
    {error ? <button type="button" className="group-text-link" disabled={busy} onClick={() => void run(async () => { const fresh = await read(); if (fresh?.own.enabled && fresh.own.copy_id) await reflect(fresh, fresh.own.copy_id); })}>再試行</button> : null}
  </section>;
}
