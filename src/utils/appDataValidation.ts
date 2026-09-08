import type {
  AnswerLog,
  AppData,
  Folder,
  ProblemSet,
  ProblemSetCreationMethod,
  ProblemSetVisibility,
  Question,
  QuestionProgress,
} from '../types';
import { normalizeFolderHierarchy } from './folderHierarchy';

export type AppDataNormalizationResult =
  | { ok: true; data: AppData }
  | { ok: false; error: string };

type NormalizationResult<T> = { ok: true; data: T } | { ok: false; error: string };

const FALLBACK_DATE = '1970-01-01T00:00:00.000Z';
const CREATION_METHODS = new Set<ProblemSetCreationMethod>([
  'manual',
  'bulk',
  'chatgpt',
  'copy',
  'import',
  'public-copy',
]);
const VISIBILITIES = new Set<ProblemSetVisibility>(['private', 'group', 'link', 'public']);

/**
 * Converts every supported version-1 payload to the canonical current shape.
 * Content records are rejected when repairing them could connect a question to
 * the wrong set. Derived study state is repaired or discarded when possible.
 */
export function normalizeAppData(value: unknown): AppDataNormalizationResult {
  if (!isRecord(value) || value.version !== 1) {
    return invalid('対応しているAppData version 1ではありません。');
  }
  if (!Array.isArray(value.folders) || !Array.isArray(value.problemSets) || !Array.isArray(value.questions)) {
    return invalid('folders、problemSets、questions は配列である必要があります。');
  }

  const foldersResult = normalizeFolders(value.folders);
  if (!foldersResult.ok) return foldersResult;
  const folderIds = new Set(foldersResult.data.map((folder) => folder.id));

  const setsResult = normalizeProblemSets(value.problemSets, folderIds);
  if (!setsResult.ok) return setsResult;
  const setsById = new Map(setsResult.data.map((set) => [set.id, set]));

  const questionsResult = normalizeQuestions(value.questions, setsById);
  if (!questionsResult.ok) return questionsResult;
  const questionsById = new Map(questionsResult.data.map((question) => [question.id, question]));

  const logsResult = normalizeAnswerLogs(Array.isArray(value.answerLogs) ? value.answerLogs : [], questionsById, setsById);
  if (!logsResult.ok) return logsResult;
  const progress = normalizeProgress(Array.isArray(value.progress) ? value.progress : [], questionsResult.data);

  return {
    ok: true,
    data: {
      version: 1,
      folders: foldersResult.data,
      problemSets: setsResult.data,
      questions: questionsResult.data,
      progress,
      answerLogs: logsResult.data,
    },
  };
}

function normalizeFolders(values: unknown[]): NormalizationResult<Folder[]> {
  const result: Folder[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !isNonEmptyString(value.id)) return invalid(`folders[${index}].id が不正です。`);
    if (ids.has(value.id)) return invalid(`folders に重複ID「${value.id}」があります。`);
    ids.add(value.id);
    const createdAt = normalizeDate(value.createdAt, normalizeDate(value.updatedAt, FALLBACK_DATE));
    result.push({
      id: value.id,
      name: typeof value.name === 'string' ? value.name : '',
      ...(isNonEmptyString(value.parentFolderId) ? { parentFolderId: value.parentFolderId } : {}),
      createdAt,
      updatedAt: normalizeDate(value.updatedAt, createdAt),
    });
  }
  return { ok: true, data: normalizeFolderHierarchy(result) };
}

function normalizeProblemSets(
  values: unknown[],
  folderIds: Set<string>,
): NormalizationResult<ProblemSet[]> {
  const result: ProblemSet[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !isNonEmptyString(value.id)) return invalid(`problemSets[${index}].id が不正です。`);
    if (ids.has(value.id)) return invalid(`problemSets に重複ID「${value.id}」があります。`);
    if (!isNonEmptyString(value.folderId) || !folderIds.has(value.folderId)) {
      return invalid(`problemSets[${index}] が存在しないフォルダを参照しています。`);
    }
    ids.add(value.id);
    const createdAt = normalizeDate(value.createdAt, normalizeDate(value.updatedAt, FALLBACK_DATE));
    const item: ProblemSet = {
      id: value.id,
      folderId: value.folderId,
      title: typeof value.title === 'string' ? value.title : '',
      source: typeof value.source === 'string' ? value.source : '',
      createdAt,
      updatedAt: normalizeDate(value.updatedAt, createdAt),
    };
    copyOptionalString(value, item, 'description');
    copyOptionalString(value, item, 'subject');
    copyOptionalString(value, item, 'audience');
    copyOptionalString(value, item, 'difficulty');
    copyOptionalString(value, item, 'sourceSetId');
    copyOptionalString(value, item, 'sourceOwnerId');
    copyOptionalString(value, item, 'sourceOwnerName');
    copyOptionalString(value, item, 'cloudSetId');
    const creationMethod = normalizeCreationMethod(value.creationMethod);
    if (creationMethod) item.creationMethod = creationMethod;
    if (typeof value.visibility === 'string') {
      item.visibility = VISIBILITIES.has(value.visibility as ProblemSetVisibility)
        ? value.visibility as ProblemSetVisibility
        : 'private';
    }
    const copiedAt = normalizeOptionalDate(value.copiedAt);
    if (copiedAt) item.copiedAt = copiedAt;
    result.push(item);
  }
  return { ok: true, data: result };
}

function normalizeQuestions(
  values: unknown[],
  setsById: Map<string, ProblemSet>,
): NormalizationResult<Question[]> {
  const result: Question[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !isNonEmptyString(value.id)) return invalid(`questions[${index}].id が不正です。`);
    if (ids.has(value.id)) return invalid(`questions に重複ID「${value.id}」があります。`);
    if (!isNonEmptyString(value.setId) || !setsById.has(value.setId)) {
      return invalid(`questions[${index}] が存在しない問題セットを参照しています。`);
    }
    if (!Array.isArray(value.choices) || (value.choices.length !== 4 && value.choices.length !== 5)
      || !value.choices.every((choice) => typeof choice === 'string')) {
      return invalid(`questions[${index}].choices は4個または5個の文字列である必要があります。`);
    }
    const answerResult = normalizeAnswerIndexes(value, value.choices.length);
    if (!answerResult.ok) return invalid(`questions[${index}] ${answerResult.error}`);
    ids.add(value.id);
    const createdAt = normalizeDate(value.createdAt, normalizeDate(value.updatedAt, FALLBACK_DATE));
    const choices = value.choices as Question['choices'];
    const item: Question = {
      id: value.id,
      setId: value.setId,
      question: typeof value.question === 'string' ? value.question : '',
      choices,
      answerIndex: answerResult.data[0],
      answerIndexes: answerResult.data,
      answerText: typeof value.answerText === 'string'
        ? value.answerText
        : answerResult.data.map((answerIndex) => choices[answerIndex]).join(' / '),
      explanation: typeof value.explanation === 'string' ? value.explanation : '',
      sourcePage: typeof value.sourcePage === 'string' ? value.sourcePage : '',
      category: typeof value.category === 'string' ? value.category : '',
      difficulty: typeof value.difficulty === 'string' ? value.difficulty : 'standard',
      createdAt,
      updatedAt: normalizeDate(value.updatedAt, createdAt),
    };
    if (typeof value.detailedExplanation === 'string') item.detailedExplanation = value.detailedExplanation;
    if (value.distractors !== undefined) {
      if (!Array.isArray(value.distractors) || value.distractors.length > 50 || !value.distractors.every((text) => isNonEmptyString(text) && text.length <= 10000)) return invalid(`questions[${index}].distractors が不正です。`);
      item.distractors = [...new Set(value.distractors as string[])];
    }
    if (value.shuffleChoices !== undefined) {
      if (typeof value.shuffleChoices !== 'boolean') return invalid(`questions[${index}].shuffleChoices が不正です。`);
      item.shuffleChoices = value.shuffleChoices;
    }
    if (value.detailedAnswer !== undefined) {
      const detail = value.detailedAnswer;
      if (!isRecord(detail) || typeof detail.body !== 'string' || !Array.isArray(detail.imageIds)
        || detail.imageIds.length > 4 || !detail.imageIds.every(isNonEmptyString)) {
        return invalid(`questions[${index}].detailedAnswer が不正です。`);
      }
      item.detailedAnswer = { body: detail.body, imageIds: [...new Set(detail.imageIds as string[])], updatedAt: normalizeDate(detail.updatedAt, item.updatedAt) };
    }
    if (value.questionImageIds !== undefined) {
      if (!Array.isArray(value.questionImageIds) || !value.questionImageIds.every(isNonEmptyString)) {
        return invalid(`questions[${index}].questionImageIds が不正です。`);
      }
      item.questionImageIds = [...new Set(value.questionImageIds as string[])];
    }
    result.push(item);
  }
  return { ok: true, data: result };
}

function normalizeAnswerIndexes(
  value: Record<string, unknown>,
  choiceCount: number,
): { ok: true; data: number[] } | { ok: false; error: string } {
  const suppliedIndexes = value.answerIndexes;
  if (suppliedIndexes !== undefined) {
    if (!Array.isArray(suppliedIndexes) || suppliedIndexes.length === 0
      || !suppliedIndexes.every((item) => Number.isInteger(item) && item >= 0 && item < choiceCount)) {
      return { ok: false, error: 'answerIndexes が選択肢の範囲外です。' };
    }
    return { ok: true, data: [...new Set(suppliedIndexes as number[])].sort((a, b) => a - b) };
  }
  if (!Number.isInteger(value.answerIndex) || (value.answerIndex as number) < 0 || (value.answerIndex as number) >= choiceCount) {
    return { ok: false, error: 'answerIndex が選択肢の範囲外です。' };
  }
  return { ok: true, data: [value.answerIndex as number] };
}

function normalizeProgress(values: unknown[], questions: Question[]): QuestionProgress[] {
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const byQuestionId = new Map<string, QuestionProgress>();
  for (const value of values) {
    if (!isRecord(value) || !isNonEmptyString(value.questionId)) continue;
    const question = questionsById.get(value.questionId);
    if (!question) continue;
    const correctCount = toNonNegativeInteger(value.correctCount);
    const wrongCount = toNonNegativeInteger(value.wrongCount);
    const countTotal = correctCount + wrongCount;
    const statedCount = toNonNegativeInteger(value.answeredCount);
    const lastSelectedIndex = Number.isInteger(value.lastSelectedIndex)
      && (value.lastSelectedIndex as number) >= -1
      && (value.lastSelectedIndex as number) < question.choices.length
      ? value.lastSelectedIndex as number
      : null;
    const normalized: QuestionProgress = {
      questionId: question.id,
      answeredCount: Math.max(statedCount, countTotal),
      correctCount,
      wrongCount,
      lastSelectedIndex,
      lastAnswerCorrect: typeof value.lastAnswerCorrect === 'boolean' ? value.lastAnswerCorrect : null,
      lastAnsweredAt: normalizeOptionalDate(value.lastAnsweredAt),
      isReview: typeof value.isReview === 'boolean' ? value.isReview : false,
      isAmbiguous: typeof value.isAmbiguous === 'boolean' ? value.isAmbiguous : false,
      reviewLevel: value.reviewLevel === 1 || value.reviewLevel === 2 || value.reviewLevel === 3 ? value.reviewLevel : null,
      isGraduated: typeof value.isGraduated === 'boolean' ? value.isGraduated : false,
    };
    const existing = byQuestionId.get(question.id);
    if (!existing || progressFreshness(normalized) >= progressFreshness(existing)) byQuestionId.set(question.id, normalized);
  }
  return questions.map((question) => byQuestionId.get(question.id) ?? createInitialProgress(question.id));
}

function normalizeAnswerLogs(
  values: unknown[],
  questionsById: Map<string, Question>,
  setsById: Map<string, ProblemSet>,
): NormalizationResult<AnswerLog[]> {
  const result: AnswerLog[] = [];
  const byId = new Map<string, AnswerLog>();
  for (const value of values) {
    if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.questionId)) continue;
    const question = questionsById.get(value.questionId);
    const set = question ? setsById.get(question.setId) : undefined;
    if (!question || !set) continue;
    const answeredAt = normalizeOptionalDate(value.answeredAt);
    if (!answeredAt) continue;
    const selectedIndexes = Array.isArray(value.selectedIndexes)
      ? value.selectedIndexes
      : (Number.isInteger(value.selectedIndex) && (value.selectedIndex as number) >= 0 ? [value.selectedIndex] : []);
    if (!selectedIndexes.every((item) => Number.isInteger(item) && item >= 0 && item < question.choices.length)) continue;
    const indexes = [...new Set(selectedIndexes as number[])].sort((a, b) => a - b);
    const selectedIndex = indexes[0] ?? -1;
    const normalized: AnswerLog = {
      id: value.id,
      questionId: question.id,
      setId: set.id,
      folderId: set.folderId,
      selectedIndex,
      ...(indexes.length > 0 ? { selectedIndexes: indexes } : {}),
      ...(Array.isArray(value.presentedChoices) && value.presentedChoices.length === question.choices.length && value.presentedChoices.every((text) => typeof text === 'string') ? { presentedChoices: value.presentedChoices as string[] } : {}),
      isCorrect: typeof value.isCorrect === 'boolean' ? value.isCorrect : false,
      answeredAt,
    };
    const existing = byId.get(normalized.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        return invalid(`answerLogs に内容の異なる重複ID「${normalized.id}」があります。`);
      }
      continue;
    }
    byId.set(normalized.id, normalized);
    result.push(normalized);
  }
  return { ok: true, data: result };
}

function createInitialProgress(questionId: string): QuestionProgress {
  return {
    questionId,
    answeredCount: 0,
    correctCount: 0,
    wrongCount: 0,
    lastSelectedIndex: null,
    lastAnswerCorrect: null,
    lastAnsweredAt: null,
    isReview: false,
    isAmbiguous: false,
    reviewLevel: null,
    isGraduated: false,
  };
}

function progressFreshness(progress: QuestionProgress): number {
  return Date.parse(progress.lastAnsweredAt ?? '') || progress.answeredCount;
}

function normalizeCreationMethod(value: unknown): ProblemSetCreationMethod | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (CREATION_METHODS.has(value as ProblemSetCreationMethod)) return value as ProblemSetCreationMethod;
  if (value === 'chat-gpt' || value === 'ai') return 'chatgpt';
  return 'import';
}

function normalizeOptionalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeDate(value: unknown, fallback: string): string {
  return normalizeOptionalDate(value) ?? fallback;
}

function toNonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function copyOptionalString<K extends keyof ProblemSet>(
  source: Record<string, unknown>,
  target: ProblemSet,
  key: K,
): void {
  if (typeof source[key] === 'string') {
    (target as unknown as Record<string, unknown>)[key] = source[key];
  }
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
