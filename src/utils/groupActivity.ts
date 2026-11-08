import type { AppData, QuizResult } from '../types';
import { groupStudySelection } from './groupStudySource';
import { questionRevision } from './studyPlans';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type StudyActivity = { id: string; setId: string; versionId: string; copyId: string; startedAt: string; finishedAt: string; answered: number; duration?: { seconds: number; startedAt: string; finishedAt: string } };
/** Only durable, revision-matching answers to imported source questions leave the device.
 * A deterministic opaque session key makes restored results and retries idempotent. */
export function buildStudyActivities(data: AppData, result: Pick<QuizResult, 'sessionAnswers' | 'studyTime'>): StudyActivity[] {
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
    const times = [...new Set(logs.map(log=>log.questionId))].map(id=>result.studyTime?.[id]);
    const valid = times.length > 0 && times.every(row=>row && row.valid === true && row.setId === set.id && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && Number.isFinite(Date.parse(row.startedAt)) && Number.isFinite(Date.parse(row.finishedAt)) && Date.parse(row.startedAt) <= Date.parse(row.finishedAt));
    const seconds = valid ? Math.floor(times.reduce((sum,row)=>sum+row!.elapsedMs,0)/1000) : 0;
    const startedAt=valid?times.map(row=>row!.startedAt).sort()[0]:'';
    const finishedAt=valid?times.map(row=>row!.finishedAt).sort().slice(-1)[0]:'';
    const duration = valid && seconds >= 1 && seconds <= 604800 && seconds <= Math.ceil((Date.parse(finishedAt)-Date.parse(startedAt))/1000)+1 ? { seconds, startedAt, finishedAt } : undefined;
    rows.push({ id: hash, setId: set.sourceSetId, versionId: set.sourceVersionId, copyId: set.id, startedAt: dates[0], finishedAt: dates[dates.length-1], answered: new Set(logs.map(log=>selection.logicalByQuestionId.get(log.questionId))).size, ...(duration ? {duration} : {}) });
  }
  return rows;
}
export type ActivityDestination = { group_id: string; generation: string; enabled_at: string; time_generation?: string | null; time_enabled_at?: string | null };
export async function publishStudyActivity(row: StudyActivity, rpc: (name: string,args: Record<string,unknown>)=>Promise<unknown>) {
  // This read contains no learning counts. OFF never sends the activity payload.
  const duration = row.duration;
  const timed = Boolean(duration && Number.isSafeInteger(duration.seconds) && duration.seconds >= 1 && duration.seconds <= 604800 && Number.isFinite(Date.parse(duration.startedAt)) && Number.isFinite(Date.parse(duration.finishedAt)) && Date.parse(duration.startedAt) <= Date.parse(duration.finishedAt) && duration.seconds <= Math.ceil((Date.parse(duration.finishedAt)-Date.parse(duration.startedAt))/1000)+1);
  const destinations = await rpc(timed?'quiz_group_activity_destinations_v2':'quiz_group_activity_destinations',{p_set_id:row.setId}) as ActivityDestination[];
  if (!Array.isArray(destinations)) throw new Error('活動の共有先を確認できません。');
  for (const d of destinations) {
    if (!d.group_id || !d.generation || !Number.isFinite(Date.parse(d.enabled_at))) throw new Error('活動の共有設定を確認できません。');
    if (Date.parse(row.startedAt)<Date.parse(d.enabled_at)) continue;
    if (timed && ((d.time_generation == null) !== (d.time_enabled_at == null) || (d.time_generation != null && (typeof d.time_generation !== 'string' || !d.time_generation || typeof d.time_enabled_at !== 'string' || !Number.isFinite(Date.parse(d.time_enabled_at)))))) throw new Error('演習時間の共有設定を確認できません。');
    const base={p_group_id:d.group_id,p_generation:d.generation,p_event_id:row.id,p_set_id:row.setId,p_version_id:row.versionId,p_copy_id:row.copyId,p_started_at:row.startedAt,p_finished_at:row.finishedAt,p_answered:row.answered};
    if (timed && d.time_generation && d.time_enabled_at && Date.parse(duration!.startedAt)>=Date.parse(d.time_enabled_at)) {
      await rpc('quiz_group_activity_publish_v2',{...base,p_time_generation:d.time_generation,p_time_started_at:duration!.startedAt,p_time_finished_at:duration!.finishedAt,p_elapsed_seconds:duration!.seconds});
    } else await rpc('quiz_group_activity_publish',base);
  }
}
