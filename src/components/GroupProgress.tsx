import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { groupProgressRpc, onCloudAuthStateChange, type CloudProblemSet } from '../utils/cloudService';
import { commonVersionProgress, type GroupProgressSnapshot } from '../utils/groupProgress';
import { importedLearning } from '../utils/groupLearning';
import { parseLearningSet, type LearningSetSnapshot } from '../utils/groupLearningService';
import { GroupEmpty, ImportedMemberProgress } from './GroupLearningUi';

export function GroupProgress({ data, groupId, set, userId, onClose, onChanged }: { data: AppData; groupId: string; set: CloudProblemSet; userId: string; onClose?: () => void; onChanged?: () => void }) {
  const [snapshot, setSnapshot] = useState<LearningSetSnapshot | null>(null);
  const [copyId, setCopyId] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const alive = useRef(true); const action = useRef(false);
  const copies = data.problemSets.filter(s => s.sourceSetId === set.id && s.sourceVersionId === set.versionId && Boolean(commonVersionProgress(data, s, set.id, set.versionId ?? '')));
  const read = async () => {
    const result = parseLearningSet(await groupProgressRpc('quiz_group_learning_set_read', { p_group_id: groupId, p_set_id: set.id }, userId));
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
    const aggregate = local && set.versionId ? importedLearning(data, local, set.id, set.versionId) : null;
    if (!aggregate || !current.own.enabled || !current.own.generation) throw new Error('取込み済みの同じ公開版を選択してください。');
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
  return <section className="group-panel group-set-progress" aria-label="取り込んだ人の進捗">
    <div className="group-panel__heading"><h2>取り込んだ人の進捗</h2>{onClose ? <button type="button" className="group-text-link" onClick={onClose}>閉じる</button> : null}</div>
    {error ? <p role="alert" className="group-error">{error}</p> : null}
    <ImportedMemberProgress members={visibleMembers.map(member => ({ userId: member.user_id, name: member.user_id === userId ? 'あなた' : member.display_name, levels: member.state === 'shared' ? member.levels : null, reflectedAt: member.reflected_at, status: member.state === 'shared' ? '反映待ち' : { not_shared: '未共有', update_pending: '更新待ち', reflection_pending: '反映待ち' }[member.state] }))} />
    {snapshot && !visibleMembers.length ? <GroupEmpty>取り込んだメンバーの進捗はまだありません。</GroupEmpty> : !snapshot && !error ? <p role="status" className="group-muted">進捗を読み込み中…</p> : null}
    <details className="group-sharing-controls"><summary>自分の進捗を共有 · {snapshot?.own.enabled ? 'ON' : 'OFF'}</summary><p className="group-muted">同じ公開版を取り込んだメンバーの集計です。共有するのはレベル別の問数と解答数です。回答内容は送信しません。</p>
      {!copies.length ? <p>{data.problemSets.some(s => s.sourceSetId === set.id) ? '現在の公開版を取り込み直すと共有できます。' : '未取込です。教材を取り込むと共有するコピーを選べます。'}</p> : <label>共有するコピー（1つ）<select aria-label="共有するコピー" disabled={busy || snapshot?.own.enabled} value={copyId} onChange={e => setCopyId(e.target.value)}><option value="">選択してください</option>{copies.map(s => <option key={s.id} value={s.id}>{s.title} / {data.folders.find(f => f.id === s.folderId)?.name}</option>)}</select></label>}
      <div className="group-sharing-controls__actions">{snapshot?.own.enabled ? <><button type="button" disabled={busy} onClick={() => void run(() => consent(false))}>共有をOFFにする</button><button type="button" disabled={busy || !copies.some(s => s.id === copyId)} onClick={() => void run(async () => { const fresh = await read(); if (fresh) await reflect(fresh, fresh.own.copy_id ?? ''); })}>自分の進捗を反映</button></> : <button type="button" disabled={busy || !snapshot || !copies.some(s => s.id === copyId) || !set.versionId} onClick={() => void run(() => consent(true))}>このコピーの集計を共有する</button>}</div>
    </details><button type="button" className="group-text-link group-progress-reload" disabled={busy} onClick={() => void run(async () => { await read(); })}>再読み込み</button>
  </section>;
}
