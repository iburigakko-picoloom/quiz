import { useEffect, useState } from 'react';
import type { AnswerLog } from '../types';
import { ensurePlanDays, PLAN_EVENT, readPlanDay, readPlans } from '../utils/studyPlanStorage';
import type { PlanDay, StudyPlan } from '../utils/studyPlans';

export function useStudyPlans(logs: readonly AnswerLog[]) {
  const [entries, setEntries] = useState<{ plan: StudyPlan; daily: PlanDay }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      try { setEntries(readPlans().flatMap(plan => { const daily = readPlanDay(plan); return daily ? [{ plan, daily }] : []; })); setError(''); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '計画を読み込めません。'); }
    };
    const prepare = () => { void ensurePlanDays(logs).then(refresh).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '日次目標を保存できません。'); }); };
    refresh(); prepare();
    window.addEventListener(PLAN_EVENT, refresh); window.addEventListener('storage', prepare);
    const interval = window.setInterval(prepare, 60_000);
    return () => { alive = false; window.removeEventListener(PLAN_EVENT, refresh); window.removeEventListener('storage', prepare); window.clearInterval(interval); };
  }, [logs]);
  return { entries, error };
}
