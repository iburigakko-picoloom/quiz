import { useCallback, useEffect, useRef, useState } from 'react';
import { groupProgressRpc, onCloudAuthStateChange } from '../utils/cloudService';
import { watchGroupProgress } from '../utils/groupReflectionQueue';
import { MemberAvatar } from './GroupLearningUi';

type Entry = { id: string; user_id: string; display_name: string; finished_at: string; answered: number };
type Page = { state: 'ready' | 'update_pending'; entries: Entry[] };

function parsePage(value: unknown): Page {
  if (!value || typeof value !== 'object') throw new Error('学習記録を読み込めません。');
  const page = value as Page;
  if (!['ready', 'update_pending'].includes(page.state) || !Array.isArray(page.entries) || page.entries.length > 50 ||
    (page.state === 'update_pending' && page.entries.length !== 0) || page.entries.some(row =>
      !row || typeof row.id !== 'string' || !/^\d+$/.test(row.id) || typeof row.user_id !== 'string' || !row.user_id ||
      typeof row.display_name !== 'string' || !Number.isSafeInteger(row.answered) || row.answered < 1 ||
      typeof row.finished_at !== 'string' || !Number.isFinite(Date.parse(row.finished_at))) ||
    new Set(page.entries.map(row => row.id)).size !== page.entries.length) throw new Error('学習記録を読み込めません。');
  return page;
}

export function GroupMaterialHistory({ groupId, setId, versionId, userId }: { groupId: string; setId: string; versionId: string; userId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const request = useRef(0);
  const depth = useRef(1);
  const active = useRef(true);
  const read = useCallback(async (before?: string) => {
    if (!active.current) return;
    const id = ++request.current;
    try {
      let cursor = before, last: Page | undefined;
      const rows: Entry[] = [];
      for (let page = 0; page < (before ? 1 : depth.current); page++) {
        last = parsePage(await groupProgressRpc('quiz_group_material_activity_history', { p_group_id: groupId, p_set_id: setId, p_version_id: versionId, p_before: cursor ?? null }, userId));
        if (id !== request.current) return;
        if (last.state === 'update_pending') throw new Error('教材の公開版が更新されています。開き直してください。');
        rows.push(...last.entries);
        if (last.entries.length < 50) break;
        cursor = last.entries[last.entries.length - 1].id;
      }
      if (before) depth.current++;
      setEntries(old => before && old ? [...old, ...rows.filter(row => !old.some(item => item.id === row.id))] : rows);
      setMore(last?.entries.length === 50); setError('');
    } catch (reason) {
      if (id === request.current) { setEntries(null); setMore(false); setError(reason instanceof Error ? reason.message : '学習記録を読み込めません。'); }
    }
  }, [groupId, setId, versionId, userId]);
  useEffect(() => {
    active.current = true; depth.current = 1; setEntries(null); void read();
    const stop = watchGroupProgress(() => void read());
    const stopAuth = onCloudAuthStateChange((_event, session) => { if (session?.user.id !== userId) { active.current = false; request.current++; setEntries(null); setError('アカウントが変更されています。画面を閉じてください。'); } });
    return () => { active.current = false; request.current++; stop(); stopAuth(); };
  }, [read, userId]);
  return <section aria-label="この教材の学習記録">
    {error ? <p role="alert">{error}</p> : entries === null ? <p role="status">読み込み中…</p> : entries.length === 0 ? <p>共有された学習記録はありません。</p> : entries.map(row => <article key={row.id} className="group-timeline__row">
      <div className="group-progress-member__name"><MemberAvatar name={row.display_name} userId={row.user_id} self={row.user_id === userId}/><strong>{row.user_id === userId ? 'あなた' : row.display_name}</strong></div>
      <time dateTime={row.finished_at}>{new Date(row.finished_at).toLocaleString('ja-JP')}</time><p>{row.answered}問を解答</p>
    </article>)}
    {error ? <button type="button" className="group-text-link" onClick={() => void read()}>再試行</button> : null}
    {more && entries?.length ? <button type="button" className="group-secondary" onClick={() => void read(entries[entries.length - 1].id)}>もっと見る</button> : null}
  </section>;
}
