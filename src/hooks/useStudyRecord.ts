import { useMemo } from 'react';
import type { AnswerLog } from '../types';
import { getDailyAnswerCounts, getStudySummary } from '../utils/studyRecord';
import { useLocalDay } from './useLocalDay';

export function useStudyRecord(logs: readonly AnswerLog[]) {
  const day = useLocalDay();
  const counts = useMemo(() => getDailyAnswerCounts(logs), [logs]);
  const summary = useMemo(() => getStudySummary(counts), [counts, day]);
  return { summary, day };
}
