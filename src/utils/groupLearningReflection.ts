import type { AppData, ProblemSet } from '../types';
import { importedLearning } from './groupLearning';
import { parseGroupProgress } from './groupProgress';
import type { CloudProblemSet } from './cloudService';
import { groupStudyCandidates } from './groupStudySource';

export type GroupLearningTransport = (name: 'quiz_group_learning_set_read' | 'quiz_group_progress_consent' | 'quiz_group_learning_update', params: Record<string, unknown>) => Promise<unknown>;

/** Publish the owner's aggregate from the original, without making an import.
 * A stored OFF generation is an explicit choice and is never turned back on.
 * Every write still uses the live server membership/version/consent gate. */
export async function reflectGroupSourceLearning(data: AppData, local: ProblemSet, userId: string, groupIds: readonly string[], rpc: GroupLearningTransport,
  { initialize = false, now = new Date() }: { initialize?: boolean; now?: Date } = {}) {
  const source = local.publicationSource;
  if (!source || source.ownerId !== userId || local.cloudSetId !== source.setId) return 0;
  const aggregate = importedLearning(data, local, source.setId, source.versionId, now);
  if (!aggregate) throw new Error('共有元の公開版と学習記録を確認できません。');
  let reflected = 0;
  const failures: unknown[] = [];
  for (const groupId of new Set(groupIds)) {
    try {
      const snapshot = parseGroupProgress(await rpc('quiz_group_learning_set_read', { p_group_id: groupId, p_set_id: source.setId }));
      if (snapshot.version_id !== source.versionId) continue;
      let own = snapshot.own;
      if (!own.enabled && own.generation !== null) continue;
      if (own.enabled && own.copy_id !== local.id) continue;
      if (!own.enabled || own.version_id !== source.versionId) {
        if (!initialize) continue;
        await rpc('quiz_group_progress_consent', { p_group_id: groupId, p_set_id: source.setId, p_enabled: true,
          p_copy_id: local.id, p_version_id: source.versionId, p_expected_generation: own.generation });
        // Consent only acknowledges enabled/generation. Read the authoritative
        // copy/version binding again, including an OFF that raced the request.
        const fresh = parseGroupProgress(await rpc('quiz_group_learning_set_read', { p_group_id: groupId, p_set_id: source.setId }));
        own = fresh.own;
        if (fresh.version_id !== source.versionId || !own.enabled || own.copy_id !== local.id || own.version_id !== source.versionId) continue;
      }
      if (!own?.enabled || !own.generation || own.copy_id !== local.id || own.version_id !== source.versionId) throw new Error('進捗の共有設定が変更されています。');
      await rpc('quiz_group_learning_update', { p_group_id: groupId, p_set_id: source.setId, p_generation: own.generation,
        p_copy_id: local.id, p_version_id: source.versionId, p_answered: aggregate.answered, p_levels: aggregate.levels,
        p_today: aggregate.todayCount, p_week: aggregate.weekCount, p_day: aggregate.day, p_week_start: aggregate.weekStart });
      reflected++;
    } catch (error) { failures.push(error); }
  }
  // Successful groups stay reflected; retrying sends absolute counts, never an
  // increment. A failed destination cannot silently hide behind a success.
  if (failures.length) throw failures[0];
  return reflected;
}

/** Refresh already enabled owner sources after durable exercise completion.
 * Reading the current immutable snapshot fills large, intentionally unretained
 * manifests. This path never creates consent or replaces a selected copy. */
export async function reflectOwnedStudyLearning(data: AppData, setIds: readonly string[], userId: string, rpc: GroupLearningTransport,
  loadShared: (setId: string) => Promise<CloudProblemSet>, now = new Date()) {
  let reflected = 0;
  const failures: unknown[] = [];
  for (const local of data.problemSets.filter(set => setIds.includes(set.id))) {
    const source = local.publicationSource;
    if (!source || source.ownerId !== userId || local.cloudSetId !== source.setId || !source.groupIds.length) continue;
    try {
      const candidate = source.manifest?.length ? local : groupStudyCandidates(data, await loadShared(source.setId), userId).find(set => set.id === local.id);
      if (!candidate) continue;
      reflected += await reflectGroupSourceLearning(data, candidate, userId, source.groupIds, rpc, { now });
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
  return reflected;
}
