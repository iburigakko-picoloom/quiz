import { useMemo } from 'react';
import type { AnswerLog } from '../types';
import { getDailyAnswerCounts, getStudySummary } from '../utils/studyRecord';
import { useLocalDay } from './useLocalDay';
import { getStudyTimeZone } from '../utils/studyPlanStorage';
import { studyDay } from '../utils/studyPlans';

export function useStudyRecord(logs: readonly AnswerLog[]) {
  const day = useLocalDay();
  const zone = getStudyTimeZone();
  const counts = useMemo(() => getDailyAnswerCounts(logs, zone), [logs, zone]);
  const fixedDay = studyDay(new Date(), zone);
  const summary = useMemo(() => getStudySummary(counts, new Date(`${fixedDay}T12:00:00`)), [counts, day, fixedDay]);
  return { summary, day };
}
