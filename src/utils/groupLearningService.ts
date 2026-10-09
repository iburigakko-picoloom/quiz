import { groupProgressRpc } from './cloudService';
import { groupAccents, groupIcons, groupTimeZone, type GroupAccent, type GroupIconName, type GroupLearningMember, type LevelCounts } from './groupLearning';
import { nextDay, studyDay } from './studyPlans';
import { parseGroupProgress, type GroupProgressSnapshot } from './groupProgress';

export interface GroupSharedFolder { id: string; name: string; parentId: string | null; createdBy: string | null; creatorName: string; createdAt: string; updatedAt: string; importCount: number }
export interface GroupLearningSnapshot {
  icon: GroupIconName;
  accent: GroupAccent;
  folders: GroupSharedFolder[];
  placements: { setId: string; folderId: string | null }[];
  members: GroupLearningMember[];
}
export type LearningSetSnapshot = Omit<GroupProgressSnapshot, 'members'> & { members: (GroupProgressSnapshot['members'][number] & { levels: LevelCounts | null; imported: boolean })[] };

export function parseLevels(value: unknown): LevelCounts | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('レベル別の集計を確認できません。');
  return value as LevelCounts;
}
export function parseLearningSet(value: unknown): LearningSetSnapshot {
  const snapshot = parseGroupProgress(value);
  return { ...snapshot, members: snapshot.members.map(member => {
    const levels = parseLevels((member as typeof member & { levels?: unknown }).levels);
    if (levels && (member.state !== 'shared' || levels.reduce((sum, n) => sum + n, 0) !== member.total)) throw new Error('進捗の対象数を確認できません。');
    return { ...member, levels, imported: (member as typeof member & { imported?: unknown }).imported === true };
  }) };
}
export async function readGroupLearning(groupId: string, userId: string): Promise<GroupLearningSnapshot> {
  const day = studyDay(new Date(), groupTimeZone);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const value = await groupProgressRpc('quiz_group_learning_read', { p_group_id: groupId, p_day: day, p_week_start: nextDay(day, -(weekday === 0 ? 6 : weekday - 1)) }, userId) as Record<string, unknown>;
  if (!value || !Array.isArray(value.folders) || !Array.isArray(value.placements) || !Array.isArray(value.members)) throw new Error('グループの情報を確認できません。');
  const count = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('グループの集計を確認できません。'); return Number(value); };
  return {
    icon: groupIcons.includes(value.icon as GroupIconName) ? value.icon as GroupIconName : 'group',
    accent: groupAccents.includes(value.accent as GroupAccent) ? value.accent as GroupAccent : 'blue',
    folders: value.folders.map((row: Record<string, unknown>) => ({ id: String(row.id), name: String(row.name), parentId: row.parent_folder_id ? String(row.parent_folder_id) : null, createdBy: row.created_by ? String(row.created_by) : null, creatorName: String(row.creator_name ?? '作成者未記録'), createdAt: String(row.created_at), updatedAt: String(row.updated_at ?? row.created_at), importCount: count(row.import_count) })),
    placements: value.placements.map((row: Record<string, unknown>) => ({ setId: String(row.set_id), folderId: row.group_folder_id ? String(row.group_folder_id) : null })),
    members: value.members.map((row: Record<string, unknown>) => {
      if (!['owner', 'admin', 'member'].includes(String(row.role)) || !row.user_id) throw new Error('メンバー情報を確認できません。');
      return { userId: String(row.user_id), displayName: String(row.display_name), role: row.role as GroupLearningMember['role'], importedSetCount: count(row.imported_set_count), levels: parseLevels(row.levels), todayCount: row.today_count === null ? null : count(row.today_count), weekCount: row.week_count === null ? null : count(row.week_count), sharedSetCount: count(row.shared_set_count) };
    }),
  };
}
