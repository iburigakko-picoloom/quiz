import type { AnswerLog, AppData, Question } from '../types';

export type PlanKind = 'deadline' | 'habit';
export type PlanTarget = { questionId: string; logicalId: string; revision: string; question: Question; baselineLogIds: string[] };
export type PlanSchedule = { effectiveDay: string; kind: PlanKind; deadline: string; weekdays: number[]; holidays: string[]; dailyCounts: number[]; paused: boolean };
export type StudyPlan = { schema: 1; id: string; title: string; setId: string; setTitle: string; sourceVersionId?: string; timeZone: string; createdAt: string; updatedAt: string; targets: PlanTarget[]; schedules: PlanSchedule[] };
export type PlanDay = { schema: 1; planId: string; day: string; goal: number; targetIds: string[] };

/** Exact canonical content, never a fuzzy text match or a collision-prone hash. */
export function questionRevision(q: Question): string {
  return JSON.stringify([q.question, q.choices, q.answerIndexes?.length ? q.answerIndexes : [q.answerIndex], q.answerText, q.explanation, q.detailedExplanation ?? '', q.sourcePage, q.category, q.difficulty, q.distractors ?? [], q.shuffleChoices ?? null, q.questionImageIds ?? []]);
}
export function validTimeZone(zone: string): boolean { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }
export function studyDay(value: string | Date, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}
export function validDay(day: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day; }
export function nextDay(day: string, offset = 1): string { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
export function scheduleFor(plan: StudyPlan, day: string): PlanSchedule { return [...plan.schedules].reverse().find(s => s.effectiveDay <= day) ?? plan.schedules[0]; }
export function scheduledDay(schedule: PlanSchedule, day: string): boolean { return schedule.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay()) && !schedule.holidays.includes(day); }
export function eligibleLog(log: AnswerLog, target: PlanTarget): boolean {
  return log.questionId === target.questionId && (log.questionRevision === target.revision || target.baselineLogIds.includes(log.id));
}
export function targetLogs(plan: StudyPlan, logs: readonly AnswerLog[]): AnswerLog[] {
  const targets = new Map(plan.targets.map(t => [t.questionId, t]));
  const ids = new Set<string>();
  return logs.filter(log => { const t = targets.get(log.questionId); if (!t || ids.has(log.id) || !eligibleLog(log, t)) return false; ids.add(log.id); return true; });
}
export function makePlanDay(plan: StudyPlan, logs: readonly AnswerLog[], day: string): PlanDay {
  const schedule = scheduleFor(plan, day);
  const before = new Set(targetLogs(plan, logs).filter(log => studyDay(log.answeredAt, plan.timeZone) < day).map(log => log.questionId));
  const remaining = plan.targets.filter(t => !before.has(t.questionId)).map(t => t.questionId);
  let goal = 0;
  if (!schedule.paused && scheduledDay(schedule, day)) {
    if (schedule.kind === 'habit') goal = Math.min(plan.targets.length, schedule.dailyCounts[new Date(`${day}T12:00:00Z`).getUTCDay()]);
    else if (day <= schedule.deadline) {
      let days = 0;
      // Calendar arithmetic is independent of DST; bounded to the supported ten-year horizon.
      for (let cursor = day, i = 0; cursor <= schedule.deadline && i < 3661; cursor = nextDay(cursor), i++) if (scheduledDay(schedule, cursor)) days++;
      goal = days ? Math.ceil(remaining.length / days) : 0;
    }
  }
  return { schema: 1, planId: plan.id, day, goal, targetIds: schedule.kind === 'deadline' ? remaining : plan.targets.map(t => t.questionId) };
}
export function planStatus(plan: StudyPlan, data: AppData, daily: PlanDay, now = new Date()) {
  const logs = targetLogs(plan, data.answerLogs);
  const today = logs.filter(log => studyDay(log.answeredAt, plan.timeZone) === daily.day && daily.targetIds.includes(log.questionId));
  const answeredToday = new Set(today.map(log => log.questionId));
  const answeredAll = new Set(logs.map(log => log.questionId));
  const schedule = scheduleFor(plan, daily.day);
  const missing = plan.targets.filter(t => !data.questions.some(q => q.id === t.questionId && questionRevision(q) === t.revision));
  const available = new Map(data.questions.map(q => [q.id, q]));
  const todo = daily.targetIds.filter(id => !answeredToday.has(id) && (schedule.kind !== 'deadline' || !answeredAll.has(id)));
  const questions = todo.map(id => plan.targets.find(t => t.questionId === id)!).filter(t => available.has(t.questionId) && questionRevision(available.get(t.questionId)!) === t.revision).slice(0, Math.max(0, daily.goal - answeredToday.size)).map(t => t.question);
  return { day: daily.day, goal: daily.goal, done: answeredToday.size, remaining: Math.max(0, daily.goal - answeredToday.size), total: plan.targets.length, answered: answeredAll.size, complete: answeredAll.size === plan.targets.length, todayComplete: daily.goal > 0 && answeredToday.size >= daily.goal, expired: schedule.kind === 'deadline' && studyDay(now, plan.timeZone) > schedule.deadline && answeredAll.size < plan.targets.length, paused: schedule.paused, missing: missing.length, questions, accuracy: logs.length ? Math.round(logs.filter(l => l.isCorrect).length / logs.length * 100) : null, answerCount: logs.length };
}
export function snapshotTargets(questions: Question[], logs: readonly AnswerLog[]): PlanTarget[] {
  return questions.map(q => ({ questionId: q.id, logicalId: q.logicalId ?? q.origin?.logicalId ?? q.id, revision: questionRevision(q), question: structuredClone(q), baselineLogIds: logs.filter(l => l.questionId === q.id && (l.questionRevision === questionRevision(q) || (!l.questionRevision && l.answeredAt >= q.updatedAt))).map(l => l.id) }));
}
export function aggregatePlanToday(entries: { plan: StudyPlan; daily: PlanDay }[], data: AppData) {
  const required = new Set<string>(); const answered = new Set<string>();
  // Pick each plan's stable assigned slice; overlaps are counted once globally.
  for (const { plan, daily } of entries) {
    const ids = new Set(daily.targetIds.slice(0, daily.goal));
    ids.forEach(id => required.add(id));
    targetLogs(plan, data.answerLogs).filter(l => studyDay(l.answeredAt, plan.timeZone) === daily.day && daily.targetIds.includes(l.questionId) && daily.goal > 0).forEach(l => answered.add(l.questionId));
  }
  return { done: answered.size, goal: required.size };
}
export function parseStudyPlan(raw: string): StudyPlan {
  const p = JSON.parse(raw) as StudyPlan;
  if (!p || p.schema !== 1 || !p.id || !p.setId || typeof p.title !== 'string' || typeof p.setTitle !== 'string' || !validTimeZone(p.timeZone) || !Number.isFinite(Date.parse(p.createdAt)) || !Number.isFinite(Date.parse(p.updatedAt)) || !Array.isArray(p.targets) || !p.targets.length || p.targets.length > 10000 || !Array.isArray(p.schedules) || !p.schedules.length) throw new Error('学習計画の保存形式を確認できません。');
  const ids = new Set<string>();
  for (const t of p.targets) {
    if (!t.questionId || ids.has(t.questionId) || !t.logicalId || typeof t.revision !== 'string' || !t.question || t.question.id !== t.questionId || t.question.setId !== p.setId || !Array.isArray(t.question.choices) || !Array.isArray(t.baselineLogIds) || !t.baselineLogIds.every(id => typeof id === 'string') || questionRevision(t.question) !== t.revision) throw new Error('学習計画の対象版を確認できません。');
    ids.add(t.questionId);
  }
  let previous = '';
  for (const s of p.schedules) {
    if (!validDay(s.effectiveDay) || s.effectiveDay <= previous || !['deadline', 'habit'].includes(s.kind) || !validDay(s.deadline) || !Array.isArray(s.weekdays) || !s.weekdays.every(n => Number.isInteger(n) && n >= 0 && n <= 6) || !Array.isArray(s.holidays) || !s.holidays.every(validDay) || !Array.isArray(s.dailyCounts) || s.dailyCounts.length !== 7 || !s.dailyCounts.every(n => Number.isInteger(n) && n >= 0 && n <= 10000) || typeof s.paused !== 'boolean') throw new Error('学習計画の予定を確認できません。');
    previous = s.effectiveDay;
  }
  return p;
}
export function parsePlanDay(raw: string): PlanDay {
  const d = JSON.parse(raw) as PlanDay;
  if (!d || d.schema !== 1 || !d.planId || !validDay(d.day) || !Number.isSafeInteger(d.goal) || d.goal < 0 || !Array.isArray(d.targetIds) || d.goal > d.targetIds.length || !d.targetIds.every(id => typeof id === 'string' && id) || new Set(d.targetIds).size !== d.targetIds.length) throw new Error('学習計画の日次目標を確認できません。');
  return d;
}
