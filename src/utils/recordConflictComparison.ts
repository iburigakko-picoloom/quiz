import type { RecordConflict } from './recordSyncPull';

export type ConflictDifference = { label: string; local: string; remote: string };
export type ConflictComparison = { differences: ConflictDifference[]; incomplete: boolean; local: string; remote: string };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const parse = (raw: string | null): unknown => { try { return raw === null ? null : JSON.parse(raw); } catch { return raw; } };
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const safeText = (value: string): string => value.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/gu, '［非表示］')
  .replace(/\b(?:sk-(?:proj-)?|sb_secret_|ghp_|github_pat_)[\w-]{12,}\b/gu, '［非表示］')
  .replace(/\bBearer\s+\S+/giu, 'Bearer ［非表示］')
  .replace(/((?:password|token|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,;"']+/giu, '$1［非表示］')
  .replace(/\s+/gu, ' ').trim();
/** Only bounded, explicitly supported fields reach the screen. Originals are never altered. */
export function conflictPreview(value: unknown): string {
  if (value === undefined) return '未設定';
  if (value === null) return 'なし';
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length}件` : '詳細に違いがあります';
  const safe = safeText(String(value));
  if (!safe) return '空欄';
  return safe.length > 180 ? `${safe.slice(0, 180)}…` : safe;
}
function textDifference(a: string, b: string): [string, string] {
  const left = safeText(a), right = safeText(b);
  let changedAt = 0;
  while (changedAt < Math.min(left.length, right.length) && left[changedAt] === right[changedAt]) changedAt++;
  const start = Math.max(0, changedAt - 35);
  const excerpt = (value: string) => `${start ? '…' : ''}${value.slice(start, start + 150)}${value.length > start + 150 ? '…' : ''}` || '空欄';
  return left === right ? [conflictPreview(a), conflictPreview(b)] : [excerpt(left), excerpt(right)];
}
export function auxiliaryRecordLabel(id: string): string {
  if (id.startsWith('quizMake:planDay:')) return '計画の今日の目標';
  if (id.startsWith('quizMake:plan:')) return '学習計画';
  const labels: Record<string, string> = {
    'quiz-make-creation-notes-v1': '問題メモ',
    'quiz-make-creation-notes-v1-removed-orphans': '削除した問題のメモ',
    'quiz-make-explanation-requests-v1': '解説の作成依頼',
    'quizMake:studyTimeZone': '学習日のタイムゾーン',
    'quizMake:homePreferences': 'ホームの表示設定',
    'quiz-make-study-companion': '応援キャラクター',
  };
  return labels[id] ?? '補助データ（内容の確認が必要）';
}
const fieldLabels: Record<string, string> = {
  title: '名前', name: '名前', body: '本文', question: '問題文', explanation: '解説', resolvedBody: '解説済みのメモ',
  draft: '下書き', answerText: '正解', answerIndex: '正解の選択肢', answerIndexes: '正解の選択肢', choices: '選択肢',
  answeredCount: '回答回数', correctCount: '正解回数', wrongCount: '不正解回数', isReview: '復習', reviewLevel: '復習レベル',
  isGraduated: '復習を卒業', isAmbiguous: 'あやふや', lastAnswerCorrect: '最後の回答の正解', lastAnsweredAt: '最後の回答日時',
  isCorrect: '正解', answeredAt: '回答日時', timeZone: '学習日のタイムゾーン', setTitle: '対象の問題集',
  goal: '今日の問題数', day: '学習日', collapsed: '折りたたみ', todayCollapsed: '今日の実績を折りたたみ',
};
const fieldsFor = (collection: string, id: string): string[] => {
  if (collection === 'localStorage') {
    if (id.startsWith('quizMake:planDay:')) return ['day', 'goal'];
    if (id.startsWith('quizMake:plan:')) return ['title', 'setTitle', 'timeZone'];
    if (id === 'quizMake:homePreferences') return ['collapsed', 'todayCollapsed'];
    return [];
  }
  return ({ questions: ['question', 'choices', 'answerText', 'answerIndex', 'answerIndexes', 'explanation'],
    progress: ['answeredCount', 'correctCount', 'wrongCount', 'isReview', 'reviewLevel', 'isGraduated', 'isAmbiguous', 'lastAnswerCorrect', 'lastAnsweredAt'],
    answerLogs: ['isCorrect', 'answeredAt'], folders: ['name'], problemSets: ['title'], indexedDbNotes: ['title', 'body'] } as Record<string, string[]>)[collection] ?? [];
};
export function compareRecordConflict(item: RecordConflict): ConflictComparison {
  const left = parse(item.local?.logicalRaw??item.local?.raw??null), right = parse(item.remote.logicalRaw??item.remote.raw);
  const differences: ConflictDifference[] = [];
  const result: ConflictComparison = { differences, incomplete: false, local: item.local?.raw == null ? '削除' : 'この端末の内容', remote: item.remote.raw === null ? '削除' : 'クラウドの内容' };
  const add = (label: string, a: unknown, b: unknown) => {
    if (equal(a, b)) return;
    const [local, remote] = typeof a === 'string' && typeof b === 'string' ? textDifference(a, b) : [conflictPreview(a), conflictPreview(b)];
    differences.push({ label, local, remote });
    if (local === remote || local.includes('…') || remote.includes('…') || typeof a === 'object' || typeof b === 'object') result.incomplete = true;
  };
  const id = item.remote.id;
  if (item.remote.collection === 'localStorage' && ['quizMake:studyTimeZone', 'quiz-make-study-companion'].includes(id)) {
    add(auxiliaryRecordLabel(id), left, right); return result;
  }
  if (item.remote.collection === 'localStorage' && ['quiz-make-creation-notes-v1', 'quiz-make-creation-notes-v1-removed-orphans'].includes(id)) {
    const valid = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(row => object(row) && typeof row.id === 'string') && new Set(value.map(row => row.id)).size === value.length;
    if (valid(left) && valid(right)) {
      result.local = `${left.length}件のメモ`; result.remote = `${right.length}件のメモ`;
      const a = new Map(left.map(row => [row.id, row])), b = new Map(right.map(row => [row.id, row]));
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        const l = a.get(key), r = b.get(key), label = conflictPreview(l?.title ?? r?.title ?? 'メモ');
        if (!l || !r) { differences.push({ label, local: l ? 'あり' : 'なし', remote: r ? 'あり' : 'なし' }); continue; }
        for (const field of ['title', 'body', 'draft', 'resolvedBody', 'explanation']) add(`${label}・${fieldLabels[field]}`, l[field], r[field]);
        if (Object.keys({ ...l, ...r }).some(field => !['id', 'title', 'body', 'draft', 'resolvedBody', 'explanation'].includes(field) && !equal(l[field], r[field]))) result.incomplete = true;
      }
      if (!equal(left.map(row => row.id), right.map(row => row.id))) add('メモの並び順', 'この端末の並び順', 'クラウドの並び順');
      if (!differences.length && !equal(left, right)) result.incomplete = true;
      return result;
    }
  }
  if (item.remote.collection === 'localStorage' && id === 'quiz-make-explanation-requests-v1' && Array.isArray(left) && Array.isArray(right)) {
    result.local = `${left.length}件の依頼`; result.remote = `${right.length}件の依頼`;
    const targets = (requests: unknown[]): Array<Record<string, unknown> & { key: string }> => requests.flatMap(request => {
      const row = object(request);
      return typeof row?.id === 'string' && Array.isArray(row.targets) ? row.targets.flatMap(target => {
        const value = object(target); return typeof value?.targetId === 'string' ? [{ ...value, key: JSON.stringify([row.id, value.targetId]) }] : [];
      }) : [];
    });
    const a = new Map(targets(left).map(row => [row.key, row])), b = new Map(targets(right).map(row => [row.key, row]));
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const l = a.get(key), r = b.get(key), label = conflictPreview(l?.title ?? r?.title ?? '依頼');
      if (!l || !r) { differences.push({ label, local: l ? '依頼あり' : '依頼なし', remote: r ? '依頼あり' : '依頼なし' }); continue; }
      for (const field of ['title', 'question', 'explanation', 'previousExplanation', 'memoBodies', 'choices', 'answerIndexes']) {
        const strings = (value: unknown) => Array.isArray(value) && value.every(entry => typeof entry === 'string' || typeof entry === 'number') ? value.map(String).join(' / ') : value;
        add(`${label}・${({ previousExplanation: '以前の解説', memoBodies: '問題メモ', ...fieldLabels } as Record<string, string>)[field]}`, strings(l[field]), strings(r[field]));
      }
    }
    // Only fields actually compared above are omitted from the hidden-change check.
    const hidden = (requests: unknown[]) => requests.map(request => {
      const row = object(request); if (!row || !Array.isArray(row.targets)) return request;
      return { ...row, targets: row.targets.map(target => {
        const value = object(target); if (!value) return target;
        return Object.fromEntries(Object.entries(value).filter(([field]) => !['title', 'question', 'explanation', 'previousExplanation', 'memoBodies', 'choices', 'answerIndexes'].includes(field)));
      }) };
    });
    result.incomplete ||= !equal(hidden(left), hidden(right)) || (!differences.length && item.local?.raw !== item.remote.raw);
    return result;
  }
  const a = object(left), b = object(right), fields = fieldsFor(item.remote.collection, id);
  for (const field of fields) add(fieldLabels[field], a?.[field], b?.[field]);
  for (const field of ['choices', 'answerIndexes']) {
    const row = differences.find(difference => difference.label === fieldLabels[field]);
    if (row && Array.isArray(a?.[field]) && Array.isArray(b?.[field])) {
      row.local = conflictPreview((a![field] as unknown[]).map(conflictPreview).join(' / '));
      row.remote = conflictPreview((b![field] as unknown[]).map(conflictPreview).join(' / '));
    }
  }
  const hidden = Object.keys({ ...a, ...b }).some(field => !fields.includes(field) && !equal(a?.[field], b?.[field]));
  result.incomplete ||= hidden || (!differences.length && item.local?.raw !== item.remote.raw);
  return result;
}
