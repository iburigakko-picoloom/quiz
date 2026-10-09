import type { AppData, ProblemSet } from '../types';
import { getVirtualLevel, indexProgress } from './quiz';
import { nextDay, questionRevision, studyDay } from './studyPlans';

export type LevelCounts = [number, number, number, number];
export const groupTimeZone = 'Asia/Tokyo';
export const groupIcons = ['group', 'book', 'study', 'folder'] as const;
export type GroupIconName = typeof groupIcons[number];
export const groupAccents = ['blue', 'cyan', 'green', 'violet'] as const;
export type GroupAccent = typeof groupAccents[number];

export interface GroupLearningMember {
  userId: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  importedSetCount: number;
  levels: LevelCounts | null;
  todayCount: number | null;
  weekCount: number | null;
  sharedSetCount: number;
}

export function levelPercentages(levels: LevelCounts): LevelCounts {
  const total = levels.reduce((sum, count) => sum + count, 0);
  if (!total) return [0, 0, 0, 0];
  const raw = levels.map(count => count / total * 100);
  const result = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ index, fraction: value - result[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let remaining = 100 - result.reduce((sum, count) => sum + count, 0), i = 0; i < remaining; i++) result[order[i].index]++;
  return result as LevelCounts;
}

export function sumLevels(rows: readonly LevelCounts[]): LevelCounts {
  return rows.reduce<LevelCounts>((sum, row) => sum.map((count, i) => count + row[i]) as LevelCounts, [0, 0, 0, 0]);
}

/** Count each immutable source question once. Edited / removed questions remain L0. */
export function importedLearning(data: AppData, set: ProblemSet, publishedId: string, versionId: string, now = new Date()) {
  if (set.sourceSetId !== publishedId || set.sourceVersionId !== versionId || !set.sourceManifest?.length) return null;
  const manifest = new Map(set.sourceManifest.map(item => [item.logicalId, item.contentRevision]));
  if (manifest.size !== set.sourceManifest.length) return null;
  const eligible = new Map(data.questions.filter(q => q.setId === set.id && q.origin?.setId === publishedId && q.origin.publicationVersionId === versionId && manifest.get(q.origin.logicalId) === q.origin.contentRevision && questionRevision(q) === q.origin.importedContent).map(q => [q.id, q]));
  const progress = indexProgress(data.progress);
  const byLogical = new Map<string, number>();
  for (const q of eligible.values()) {
    const p = progress.get(q.id);
    const level = p?.isGraduated ? 3 : getVirtualLevel(p);
    byLogical.set(q.origin!.logicalId, Math.max(byLogical.get(q.origin!.logicalId) ?? 0, level));
  }
  const levels: LevelCounts = [0, 0, 0, 0];
  for (const logicalId of manifest.keys()) levels[byLogical.get(logicalId) ?? 0]++;
  const day = studyDay(now, groupTimeZone);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const weekStart = nextDay(day, -(weekday === 0 ? 6 : weekday - 1));
  let todayCount = 0; let weekCount = 0;
  const answered = new Set<string>();
  for (const log of data.answerLogs) {
    const q = eligible.get(log.questionId);
    if (!q || log.setId !== set.id || log.questionRevision !== q.origin!.importedContent) continue;
    answered.add(q.origin!.logicalId);
    const logDay = studyDay(log.answeredAt, groupTimeZone);
    if (logDay === day) todayCount++;
    if (logDay >= weekStart && logDay <= day) weekCount++;
  }
  return { levels, total: manifest.size, answered: answered.size, todayCount, weekCount, day, weekStart };
}

export function sortLearningMembers(members: readonly GroupLearningMember[], sort: 'today' | 'week' | 'l3') {
  const value = (member: GroupLearningMember) => sort === 'l3'
    ? member.levels && member.levels.reduce((sum, n) => sum + n, 0) ? member.levels[3] / member.levels.reduce((sum, n) => sum + n, 0) : null
    : sort === 'week' ? member.weekCount : member.todayCount;
  return [...members].sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av === null || bv === null) return av === bv ? a.displayName.localeCompare(b.displayName, 'ja') : av === null ? 1 : -1;
    return bv - av || a.displayName.localeCompare(b.displayName, 'ja');
  });
}
