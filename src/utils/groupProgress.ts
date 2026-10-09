import type { AppData, ProblemSet } from '../types';
import { questionRevision } from './studyPlans';
import { groupStudySelection } from './groupStudySource';

/** One selected local original or copy, one immutable publication version. */
export function commonVersionProgress(data: AppData, set: ProblemSet, publishedId: string, versionId: string) {
  const selection=groupStudySelection(data,set,publishedId,versionId);if(!selection)return null;
  const {manifest,eligible,logicalByQuestionId}=selection;
  const answered = new Set<string>();
  for (const log of data.answerLogs) {
    const q = eligible.get(log.questionId);
    if (q && log.setId===set.id && log.questionRevision === questionRevision(q)) answered.add(logicalByQuestionId.get(q.id)!);
  }
  return { answered: answered.size, total: manifest.size };
}
export type GroupProgressSnapshot = {
  version_id: string | null;
  own: { generation: string | null; enabled: boolean; copy_id: string | null; version_id: string | null };
  members: { user_id: string; display_name: string; state: 'not_shared' | 'update_pending' | 'reflection_pending' | 'shared'; answered: number | null; total: number | null; reflected_at: string | null }[];
};
export function parseGroupProgress(value: unknown): GroupProgressSnapshot {
  const snapshot = value as GroupProgressSnapshot;
  if (!snapshot || !snapshot.own || !Array.isArray(snapshot.members) || typeof snapshot.own.enabled !== 'boolean') throw new Error('共有進捗の応答を確認できません。');
  for (const row of snapshot.members) {
    if (!row.user_id || typeof row.display_name !== 'string' || !['not_shared', 'update_pending', 'reflection_pending', 'shared'].includes(row.state)) throw new Error('共有進捗の形式が不正です。');
    if (row.state === 'shared' && (!Number.isSafeInteger(row.answered) || !Number.isSafeInteger(row.total) || row.answered! < 0 || row.total! <= 0 || row.answered! > row.total! || !row.reflected_at || !Number.isFinite(Date.parse(row.reflected_at)))) throw new Error('共有進捗の集計を確認できません。');
    if (row.state !== 'shared' && (row.answered !== null || row.total !== null || row.reflected_at !== null)) throw new Error('共有されていない進捗が含まれています。');
  }
  return snapshot;
}
