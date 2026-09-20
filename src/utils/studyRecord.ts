import type { AnswerLog, AppData, Question } from '../types';
import { toLocalDateKey } from './date';
import { isReviewTarget } from './reviewTargets';

export function getDailyAnswerCounts(logs: readonly AnswerLog[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const key = toLocalDateKey(log.answeredAt);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function localDay(date: Date, offset = 0) {
  // Calendar arithmetic, not 24-hour subtraction: safe across DST and month ends.
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}

export function getStudySummary(counts: ReadonlyMap<string, number>, now = new Date()) {
  const todayKey = toLocalDateKey(now);
  const todayCount = counts.get(todayKey) ?? 0;
  let cursor = localDay(now, todayCount > 0 ? 0 : -1);
  let streak = 0;
  while ((counts.get(toLocalDateKey(cursor)) ?? 0) > 0) {
    streak += 1;
    cursor = localDay(cursor, -1);
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = localDay(now, index - 6);
    const key = toLocalDateKey(date);
    return { key, label: '日月火水木金土'[date.getDay()], count: counts.get(key) ?? 0 };
  });
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const calendar = Array.from({ length: monthDays }, (_, index) => {
    const key = toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), index + 1));
    return { key, day: index + 1, count: counts.get(key) ?? 0, isToday: key === todayKey };
  });
  return { todayCount, streak, days, calendar, month: now.getMonth() + 1, monthOffset: (start.getDay() + 6) % 7 };
}

export type StudySummary = ReturnType<typeof getStudySummary>;

export function getRecommendedReviewQuestions(data: AppData, now = new Date()) {
  const progressById = new Map(data.progress.map((progress) => [progress.questionId, progress]));
  const setIds = new Set(data.problemSets.map((set) => set.id));
  const today = localDay(now).getTime();
  const candidates: { question: Question; priority: number; due: number; accuracy: number; needsCheck: boolean }[] = [];
  for (const question of data.questions) {
    const progress = progressById.get(question.id);
    if (!setIds.has(question.setId) || !progress || !isReviewTarget(progress)) continue;
    const last = progress.lastAnsweredAt ? new Date(progress.lastAnsweredAt) : null;
    const validLast = last && Number.isFinite(last.getTime()) && last.getTime() <= now.getTime();
    const interval = progress.reviewLevel === 3 ? 7 : progress.reviewLevel === 2 ? 3 : 1;
    const due = validLast ? localDay(last, interval).getTime() : Infinity;
    const isDue = progress.answeredCount > 0 && due <= today;
    const isWrong = progress.answeredCount > 0 && progress.lastAnswerCorrect === false;
    if (!progress.isAmbiguous && !isWrong && !isDue) continue;
    candidates.push({
      question,
      priority: progress.isAmbiguous ? 0 : isWrong ? 1 : due < today ? 2 : 3,
      due,
      accuracy: progress.answeredCount > 0 ? progress.correctCount / Math.max(progress.answeredCount, progress.correctCount + progress.wrongCount) : 0,
      needsCheck: progress.isAmbiguous || !isDue,
    });
  }
  candidates.sort((a, b) => a.priority - b.priority || (a.due === b.due ? 0 : a.due - b.due) || a.accuracy - b.accuracy || a.question.id.localeCompare(b.question.id));
  const selected = candidates.slice(0, 10);
  const needsCheckCount = selected.filter((item) => item.needsCheck).length;
  return { questions: selected.map((item) => item.question), needsCheckCount, dueCount: selected.length - needsCheckCount };
}
