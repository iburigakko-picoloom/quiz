import type { AppData, QuizResult } from '../types';
import { groupStudySelection } from './groupStudySource';
import { questionRevision } from './studyPlans';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type StudyActivity = { id: string; setId: string; versionId: string; copyId: string; startedAt: string; finishedAt: string; answered: number };
/** Only durable, revision-matching answers to imported source questions leave the device.
 * A deterministic opaque session key makes restored results and retries idempotent. */
export function buildStudyActivities(data: AppData, result: Pick<QuizResult, 'sessionAnswers'>): StudyActivity[] {
  const ids = new Set(result.sessionAnswers?.flatMap(a=>a.answerLogId ? [a.answerLogId] : []) ?? []);
  const rows: StudyActivity[] = [];
  for (const set of data.problemSets) {
    if (!set.sourceSetId || !set.sourceVersionId || set.publicationSource) continue;
    const selection = groupStudySelection(data,set,set.sourceSetId,set.sourceVersionId);
    if (!selection) continue;
    const logs = data.answerLogs.filter(log=>{
      const q = selection.eligible.get(log.questionId);
      return ids.has(log.id) && log.setId===set.id && q && log.questionRevision===questionRevision(q) && Number.isFinite(Date.parse(log.answeredAt));
    });
    if (!logs.length) continue;
    const keys = [...new Set(logs.map(log=>log.id))].sort();
    const hash = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(keys))));
    const dates = logs.map(log=>new Date(log.answeredAt).toISOString()).sort();
    rows.push({ id: hash, setId: set.sourceSetId, versionId: set.sourceVersionId, copyId: set.id, startedAt: dates[0], finishedAt: dates[dates.length-1], answered: new Set(logs.map(log=>selection.logicalByQuestionId.get(log.questionId))).size });
  }
  return rows;
}
export type ActivityDestination = { group_id: string; generation: string; enabled_at: string };
export async function publishStudyActivity(row: StudyActivity, rpc: (name: string,args: Record<string,unknown>)=>Promise<unknown>) {
  // This read contains no learning counts. OFF never sends the activity payload.
  const destinations = await rpc('quiz_group_activity_destinations',{p_set_id:row.setId}) as ActivityDestination[];
  if (!Array.isArray(destinations)) throw new Error('活動の共有先を確認できません。');
  for (const d of destinations) {
    if (!d.group_id || !d.generation || !Number.isFinite(Date.parse(d.enabled_at))) throw new Error('活動の共有設定を確認できません。');
    if (Date.parse(row.startedAt)<Date.parse(d.enabled_at)) continue;
    await rpc('quiz_group_activity_publish',{p_group_id:d.group_id,p_generation:d.generation,p_event_id:row.id,p_set_id:row.setId,p_version_id:row.versionId,p_copy_id:row.copyId,p_started_at:row.startedAt,p_finished_at:row.finishedAt,p_answered:row.answered});
  }
}
