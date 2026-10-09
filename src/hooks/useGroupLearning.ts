import { useCallback, useEffect, useRef, useState } from 'react';
import { readGroupLearning, type GroupLearningSnapshot } from '../utils/groupLearningService';
import { groupTimeZone } from '../utils/groupLearning';
import { studyDay } from '../utils/studyPlans';

export function useGroupLearning(groupId: string, userId: string, revision: number) {
  const [state, setState] = useState<{ key: string; snapshot: GroupLearningSnapshot | null; error: string; loading: boolean }>({ key: '', snapshot: null, error: '', loading: false });
  const [attempt, setAttempt] = useState(0);
  const [day, setDay] = useState(() => studyDay(new Date(), groupTimeZone));
  const request = useRef(0);
  const key = `${groupId}:${userId}`;
  const refresh = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    const updateDay = () => setDay(studyDay(new Date(), groupTimeZone));
    const timer = window.setInterval(updateDay, 60_000);
    window.addEventListener('focus', updateDay); document.addEventListener('visibilitychange', updateDay);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', updateDay); document.removeEventListener('visibilitychange', updateDay); };
  }, []);
  useEffect(() => {
    const id = ++request.current;
    if (!groupId || !userId) { setState({ key, snapshot: null, error: '', loading: false }); return; }
    setState(old => ({ key, snapshot: old.key === key ? old.snapshot : null, error: '', loading: true }));
    void readGroupLearning(groupId, userId).then(snapshot => {
      if (request.current === id) setState({ key, snapshot, error: '', loading: false });
    }).catch(reason => {
      if (request.current === id) setState(old => ({ ...old, error: reason instanceof Error ? reason.message : 'グループの集計を読み込めません。', loading: false }));
    });
    return () => { request.current++; };
  }, [groupId, userId, key, revision, attempt, day]);
  return { snapshot: state.key === key ? state.snapshot : null, error: state.key === key ? state.error : '', loading: state.key === key && state.loading, refresh };
}
