import { useEffect, useMemo, useState } from 'react';
import type { AnswerLog } from '../types';
import { toLocalDateKey } from '../utils/date';
import { getDailyAnswerCounts, getStudySummary } from '../utils/studyRecord';

export function useStudyRecord(logs: readonly AnswerLog[]) {
  const [day, setDay] = useState(() => toLocalDateKey(new Date()));
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      const now = new Date();
      setDay(toLocalDateKey(now));
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 50);
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const counts = useMemo(() => getDailyAnswerCounts(logs), [logs]);
  const summary = useMemo(() => getStudySummary(counts), [counts, day]);
  return { summary, day };
}
