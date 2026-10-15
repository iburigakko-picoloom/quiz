import { useCallback, useEffect, useRef, useState } from 'react';
import { readGroupLearning, type GroupLearningSnapshot } from '../utils/groupLearningService';
import { groupTimeZone } from '../utils/groupLearning';
import { studyDay } from '../utils/studyPlans';
import { watchGroupProgress } from '../utils/groupReflectionQueue';

export function useGroupLearning(groupId: string, userId: string, revision: number) {
  const [state, setState] = useState<{ key: string; snapshot: GroupLearningSnapshot | null; error: string; loading: boolean }>({ key: '', snapshot: null, error: '', loading: false });
  const [attempt, setAttempt] = useState(0);
  const [day, setDay] = useState(() => studyDay(new Date(), groupTimeZone));
  const request = useRef(0);
  const reading = useRef(false);
  const key = `${groupId}:${userId}`;
  const refresh = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    if (!groupId || !userId) return;
    return watchGroupProgress(() => { if (!reading.current) refresh(); });
  }, [groupId, userId, refresh]);
  useEffect(() => {
    const updateDay = () => setDay(studyDay(new Date(), groupTimeZone));
    const timer = window.setInterval(updateDay, 60_000);
    window.addEventListener('focus', updateDay); document.addEventListener('visibilitychange', updateDay);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', updateDay); document.removeEventListener('visibilitychange', updateDay); };
  }, []);
  useEffect(() => {
    const id = ++request.current;
    if (!groupId || !userId) { setState({ key, snapshot: null, error: '', loading: false }); return; }
    reading.current = true;
    setState(old => ({ key, snapshot: old.key === key ? old.snapshot : null, error: '', loading: old.key !== key || !old.snapshot }));
    void readGroupLearning(groupId, userId).then(snapshot => {
      if (request.current === id) setState({ key, snapshot, error: '', loading: false });
    }).catch(reason => {
      if (request.current === id) setState(old => ({ ...old, error: reason instanceof Error ? reason.message : 'グループの集計を読み込めません。', loading: false }));
    }).finally(() => { if (request.current === id) reading.current = false; });
    return () => { request.current++; reading.current = false; };
  }, [groupId, userId, key, revision, attempt, day]);
  return { snapshot: state.key === key ? state.snapshot : null, error: state.key === key ? state.error : '', loading: state.key === key && state.loading, refresh };
}
