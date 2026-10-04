import { accountLocalStorage as localStorage } from './accountStorage';
import { withCoordinatedDataMutation } from './dataCoordination';
import { replayLocalStorageProjections, saveSyncedLocalStorage } from './localStorageRecords';
import { advanceLocalDataRevision } from './localDataRevision';
import { makePlanDay, parsePlanDay, parseStudyPlan, studyDay, validTimeZone, type PlanDay, type StudyPlan } from './studyPlans';
import type { AnswerLog } from '../types';

export const PLAN_PREFIX = 'quizMake:plan:';
export const PLAN_DAY_PREFIX = 'quizMake:planDay:';
export const STUDY_ZONE_KEY = 'quizMake:studyTimeZone';
export const HOME_PREFERENCES_KEY = 'quizMake:homePreferences';
export const PLAN_EVENT = 'quiz-make-plans-changed';
export function getStudyTimeZone(): string { const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(STUDY_ZONE_KEY); return stored && validTimeZone(stored) ? stored : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
function changed() { advanceLocalDataRevision(); window.dispatchEvent(new Event(PLAN_EVENT)); }
export function readPlans(): StudyPlan[] {
  const plans: StudyPlan[] = [];
  for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (!key?.startsWith(PLAN_PREFIX)) continue; const plan = parseStudyPlan(localStorage.getItem(key)!); if (key !== PLAN_PREFIX + plan.id) throw new Error('学習計画のIDが一致しません。'); plans.push(plan); }
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function savePlan(plan: StudyPlan, expectedRaw: string | null, retry?: { committedRaw: string | null }): Promise<void> {
  const committed = retry?.committedRaw ? parseStudyPlan(retry.committedRaw) : null;
  const raw = JSON.stringify(committed?.id === plan.id ? { ...plan, createdAt: committed.createdAt } : plan); parseStudyPlan(raw);
  await withCoordinatedDataMutation(['notes'], async () => {
    const key = PLAN_PREFIX + plan.id;
    // A prior IndexedDB commit can survive a failed localStorage projection.
    // Recover it before comparing, and accept only this editor's exact attempt.
    await replayLocalStorageProjections();
    const currentRaw = localStorage.getItem(key);
    if (currentRaw !== expectedRaw && (!retry?.committedRaw || currentRaw !== retry.committedRaw)) throw new Error('別の操作で計画が変更されました。入力を控えて開き直してください。');
    await saveSyncedLocalStorage({ [key]: raw, [STUDY_ZONE_KEY]: getStudyTimeZone() }, () => { if (retry) retry.committedRaw = raw; });
  }); changed();
}
export async function deletePlan(plan: StudyPlan, expectedRaw: string): Promise<void> {
  await withCoordinatedDataMutation(['notes'], async () => {
    if (localStorage.getItem(PLAN_PREFIX + plan.id) !== expectedRaw) throw new Error('別の操作で計画が変更されています。');
    const entries: Record<string, null> = { [PLAN_PREFIX + plan.id]: null };
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(PLAN_DAY_PREFIX + plan.id + ':')) entries[key] = null; }
    await saveSyncedLocalStorage(entries);
  }); changed();
}
export function readPlanDay(plan: StudyPlan, now = new Date()): PlanDay | null {
  const key = PLAN_DAY_PREFIX + plan.id + ':' + studyDay(now, plan.timeZone);
  const raw = localStorage.getItem(key); if (!raw) return null;
  const daily = parsePlanDay(raw);
  if (key !== PLAN_DAY_PREFIX + daily.planId + ':' + daily.day) throw new Error('日次目標のIDが一致しません。');
  return daily;
}
export async function ensurePlanDays(logs: readonly AnswerLog[], now = new Date()): Promise<void> {
  if (localStorage.getItem(STUDY_ZONE_KEY) && readPlans().every(plan => readPlanDay(plan, now))) return;
  let saved = false;
  await withCoordinatedDataMutation(['notes'], async () => {
    const entries: Record<string, string> = {};
    for (const plan of readPlans()) {
      if (readPlanDay(plan, now)) continue;
      const daily = makePlanDay(plan, logs, studyDay(now, plan.timeZone));
      entries[PLAN_DAY_PREFIX + plan.id + ':' + daily.day] = JSON.stringify(daily);
    }
    if (!localStorage.getItem(STUDY_ZONE_KEY)) entries[STUDY_ZONE_KEY] = getStudyTimeZone();
    if (Object.keys(entries).length) { await saveSyncedLocalStorage(entries); saved = true; }
  }); if (saved) changed();
}
export function validatePlanStorage(key: string, raw: string): void {
  if (key.startsWith(PLAN_PREFIX)) { const plan = parseStudyPlan(raw); if (key !== PLAN_PREFIX + plan.id) throw new Error('計画IDが一致しません。'); }
  if (key.startsWith(PLAN_DAY_PREFIX)) { const day = parsePlanDay(raw); if (key !== PLAN_DAY_PREFIX + day.planId + ':' + day.day) throw new Error('計画の日付が一致しません。'); }
  if (key === STUDY_ZONE_KEY && !validTimeZone(raw)) throw new Error('学習日のタイムゾーンが不正です。');
}
