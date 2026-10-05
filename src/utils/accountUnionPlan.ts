import type { AppData, Question } from '../types';
import { APP_COLLECTIONS, RECORD_COLLECTIONS, appRecordKey, materializeAppRecords, type AppRecord, type AppRecordState, type RecordCollection } from './appRecordStorage';
import { sameLocalAccount, validateLocalAccountIdentity, type LocalAccountIdentity } from './accountStorage';
import { createProgressSyncContext, verifiedBootstrapProgress } from './recordProgressAncestor';
import { questionRevision } from './studyPlans';
import { isChunkInternal, hashChunkBytes } from './recordChunkFormat';
import { parseQuestionImageDescriptor } from './recordQuestionImageSync';

export type UnionRecord = { key: string; collection: RecordCollection; id: string; raw: string | null; position: number; revision: number; previousRaw?: string };
export type UnionSnapshot = { identity: LocalAccountIdentity; label: string; kind: 'local' | 'cloud'; syncId?: string; head: number; records: UnionRecord[] };
export type UnionChoice = 'destination' | 'source';
export type UnionConflict = { key: string; collection: RecordCollection; id: string; kind: 'content' | 'delete-edit' | 'progress'; destination: UnionRecord; source: UnionRecord };
export type UnionPreview = { records: UnionRecord[]; conflicts: UnionConflict[]; unresolved: number; added: number; deduplicated: number; aliases: Record<string, string>; warnings: string[]; dependentDeletions: UnionRecord[]; data?: AppData };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const canonical = (value: unknown) => JSON.stringify(stable(value));
export function sameUnionContent(collection: RecordCollection, a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || ['localStorage', 'indexedDbNotes'].includes(collection)) return false;
  const clean = (raw: string) => {
    const value = JSON.parse(raw);
    if (['folders', 'problemSets', 'questions'].includes(collection)) { delete value.updatedAt; delete value.createdAt; }
    return value;
  };
  return canonical(clean(a)) === canonical(clean(b));
}
export function validateUnionSnapshot(snapshot: UnionSnapshot, identity: LocalAccountIdentity): void {
  validateLocalAccountIdentity(identity);
  if (!sameLocalAccount(validateLocalAccountIdentity(snapshot.identity), identity)) throw new Error('別のアカウントのデータは統合できません。');
  if (!['local', 'cloud'].includes(snapshot.kind) || !Number.isSafeInteger(snapshot.head) || snapshot.head < 0 || !Array.isArray(snapshot.records)) throw new Error('統合元の形式を確認できません。');
  if (snapshot.kind === 'cloud' && (!snapshot.syncId || !/^[a-f0-9]{36}$/u.test(snapshot.syncId))) throw new Error('統合元の保存先を確認できません。');
  const seen = new Set<string>();
  for (const row of snapshot.records) {
    if (!RECORD_COLLECTIONS.includes(row.collection) || !row.id || row.key !== appRecordKey(row.collection, row.id) || seen.has(row.key)
      || !(row.raw === null || typeof row.raw === 'string') || !Number.isSafeInteger(row.position) || row.position < 0
      || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > snapshot.head || isChunkInternal(row.collection, row.id)) throw new Error('統合元のレコードを確認できません。');
    seen.add(row.key);
    if (row.collection === 'localStorage' && (!/^(quizMake:|quiz-make:)/u.test(row.id) || /^(quizMake:(sync|cloud|coord):)/u.test(row.id))) throw new Error('統合元に接続設定が含まれています。学習データとして取り込めません。');
    if (row.collection === 'questionImages' && row.raw !== null && parseQuestionImageDescriptor(row.raw).id !== row.id) throw new Error('統合元の画像IDが一致しません。');
    if (APP_COLLECTIONS.some(c => c === row.collection) && row.raw !== null) {
      const value = JSON.parse(row.raw);
      if ((row.collection === 'progress' ? value.questionId : value.id) !== row.id) throw new Error('統合元のIDが一致しません。');
    }
  }
  materializeUnion(snapshot.records);
}
export function materializeUnion(records: UnionRecord[]): AppData {
  const rows = new Map(records.map(row => [row.key, { ...row, serverRevision: row.revision, localRevision: 1 } as AppRecord]));
  const counts = Object.fromEntries(APP_COLLECTIONS.map(collection => [collection, records.filter(row => row.collection === collection && row.raw !== null).length])) as AppRecordState['counts'];
  return materializeAppRecords({ state: { schema: 1, revision: 1, commitId: 'union-validation', savedAt: '2026-01-01T00:00:00.000Z', counts }, records: rows });
}
export async function unionFingerprint(snapshot: UnionSnapshot): Promise<string> {
  return hashChunkBytes(canonical({ ...snapshot, records: snapshot.records.slice().sort((a, b) => a.key.localeCompare(b.key)) }));
}

function lineage(row: UnionRecord): string | null {
  if (row.collection !== 'questions') return null;
  const raw = row.raw ?? row.previousRaw; if (!raw) return null;
  const q = JSON.parse(raw) as Question;
  // Logical IDs are scoped to the local material. A different material copy is
  // retained separately; publication text never establishes a personal identity.
  if (q.origin) return canonical([q.setId, q.origin.setId, q.origin.logicalId, q.origin.publicationVersionId]);
  return q.logicalId ? canonical([q.setId, q.logicalId]) : null;
}
function aliasMap(destination: UnionRecord[], source: UnionRecord[], warnings: string[]): Record<string, string> {
  const groups = new Map<string, UnionRecord[]>();
  for (const row of destination) { const key = lineage(row); if (key) groups.set(key, [...(groups.get(key) ?? []), row]); }
  const counts = new Map<string, number>(); for (const row of source) { const key = lineage(row); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
  const ids = new Set(destination.filter(row => row.collection === 'questions').map(row => row.id));
  const aliases: Record<string, string> = {};
  for (const row of source) {
    if (row.collection !== 'questions' || ids.has(row.id)) continue;
    const key = lineage(row), matches = key ? groups.get(key) ?? [] : [];
    if (key && matches.length === 1 && counts.get(key) === 1) aliases[row.id] = matches[0].id;
    else if (matches.length) warnings.push('同じ由来の複数コピーは判別できないため、別の問題として保持します。');
    else if (!key && row.raw && (JSON.parse(row.raw) as Question).origin === undefined) warnings.push('元の論理問題IDがない古いコピーは、文章一致で統合せず保持します。');
  }
  return aliases;
}
function remap(row: UnionRecord, aliases: Record<string, string>): UnionRecord {
  const map = (id: string) => aliases[id] ?? id;
  const id = ['questions', 'progress'].includes(row.collection) ? map(row.id) : row.id;
  const rewrite = (raw: string): string => {
    if (['localStorage', 'indexedDbNotes'].includes(row.collection)) {
      // Rewrite only documented plan IDs, never arbitrary strings or revisions.
      if (!row.id.startsWith('quizMake:plan:') && !row.id.startsWith('quizMake:planDay:')) return raw;
      const value = JSON.parse(raw);
      if (Array.isArray(value.targets)) value.targets = value.targets.map((t: { questionId: string; question: Question }) => ({ ...t, questionId: map(t.questionId), question: { ...t.question, id: map(t.question.id) } }));
      if (Array.isArray(value.targetIds)) value.targetIds = value.targetIds.map(map);
      return JSON.stringify(value);
    }
    const value = JSON.parse(raw);
    if (row.collection === 'questions') value.id = id;
    if (typeof value.questionId === 'string') value.questionId = map(value.questionId);
    return JSON.stringify(value);
  };
  return { ...row, id, key: appRecordKey(row.collection, id), raw: row.raw === null ? null : rewrite(row.raw), ...(row.previousRaw ? { previousRaw: rewrite(row.previousRaw) } : {}) };
}

/** A pure dry run. Inputs and answer-event IDs remain immutable, and revisions
 * from another stream are never used as CAS ancestors in the destination. */
export function previewAccountUnion(destination: UnionSnapshot, source: UnionSnapshot, choices: Record<string, UnionChoice> = {}): UnionPreview {
  validateUnionSnapshot(destination, destination.identity); validateUnionSnapshot(source, destination.identity);
  const warnings: string[] = [], aliases = aliasMap(destination.records, source.records, warnings);
  const input = source.records.map(row => remap(row, aliases));
  if (new Set(input.map(row => row.key)).size !== input.length) throw new Error('由来の候補が重複しています。原本は保持しています。');
  const next = new Map(destination.records.map(row => [row.key, structuredClone(row)]));
  const local = new Map(destination.records.map(row => [row.key, { ...row, localRevision: 1, serverRevision: 0 } as AppRecord]));
  const incoming = input.map(row => ({ ...row, revision: 1 }));
  const context = createProgressSyncContext(local, incoming);
  const conflicts: UnionConflict[] = []; let added = 0, deduplicated = 0, unresolved = 0;
  for (const row of input) {
    const old = next.get(row.key);
    if (!old) { next.set(row.key, { ...row, revision: 0 }); added++; continue; }
    if (row.collection === 'progress' && old.raw && row.raw) {
      const merged = verifiedBootstrapProgress(local.get(row.key)!, { ...row, revision: 1 },
        { ...local.get(row.key)!, operationId: 'union-dryrun', baseRevision: 0 }, context, 0, sameUnionContent);
      if (merged) { next.set(row.key, { ...old, raw: merged.raw }); continue; }
      const localIds = new Set((context.localLogs.get(row.id) ?? []).map(event => event.id));
      const remoteLogs = context.remoteLogs.get(row.id) ?? [];
      if (remoteLogs.length === localIds.size && remoteLogs.every(event => localIds.has(event.id) && sameUnionContent('answerLogs', event.raw, local.get(event.key)?.raw ?? null)) && sameUnionContent(row.collection, old.raw, row.raw)) { deduplicated++; continue; }
    } else if (sameUnionContent(row.collection, old.raw, row.raw)) { deduplicated++; continue; }
    const conflict: UnionConflict = { key: row.key, collection: row.collection, id: row.id, destination: old, source: row,
      kind: old.raw === null || row.raw === null ? 'delete-edit' : row.collection === 'progress' ? 'progress' : 'content' };
    conflicts.push(conflict);
    const choice = choices[row.key];
    if (choice !== 'source' && choice !== 'destination') { unresolved++; continue; }
    if (choice === 'source') next.set(row.key, { ...row, revision: old.revision });
  }
  const unknown = Object.keys(choices).find(key => !conflicts.some(conflict => conflict.key === key));
  if (unknown) throw new Error('古いプレビューの選択です。内容を確認し直してください。');
  const dependentDeletions: UnionRecord[] = [];
  if (!unresolved) {
    // Choosing a deletion also needs explicit confirmation of its dependents.
    // Their exact original events remain in the migration journal.
    let changed = true;
    while (changed) { changed = false; for (const row of next.values()) {
      if (!row.raw || (!APP_COLLECTIONS.some(c => c === row.collection) && row.collection !== 'questionImages')) continue;
      const value = JSON.parse(row.raw);
      const reference = row.collection === 'folders' && value.parentFolderId ? ['folders', value.parentFolderId]
        : row.collection === 'problemSets' ? ['folders', value.folderId]
        : row.collection === 'questions' ? ['problemSets', value.setId]
        : ['progress', 'answerLogs', 'questionImages'].includes(row.collection) ? ['questions', value.questionId] : null;
      if (reference && next.get(appRecordKey(reference[0] as RecordCollection, reference[1]))?.raw === null) {
        dependentDeletions.push(row); next.set(row.key, { ...row, raw: null }); changed = true;
      }
    } }
  }
  const records = [...next.values()];
  const data = unresolved ? undefined : materializeUnion(records);
  if (data) {
    // Check immutable plan targets and dates separately in the persistence layer.
    for (const q of data.questions) if (q.origin && questionRevision(q) !== q.origin.importedContent) warnings.push('本人が編集した問題は共通公開版の進捗に混ぜません。');
  }
  return { records, conflicts, unresolved, added, deduplicated, aliases, warnings: [...new Set(warnings)], dependentDeletions, data };
}
