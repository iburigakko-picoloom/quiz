import type { AppData, Folder, ProblemSet, Question, QuestionProgress, QuizResult, StudyStats } from '../types';
import { createId } from './id';
import { isToday, nowIso } from './date';
import { isReviewTarget } from './reviewTargets';
import { folderSubtreeIds } from './folderHierarchy';

export type ReviewLevelFilter = 'all' | 'level0' | 'level1' | 'level2' | 'level3' | 'ambiguous';
export type EffectiveReviewLevel = 0 | 1 | 2 | 3 | 'graduated';

export function createInitialProgress(questionId: string): QuestionProgress {
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

export function findProgress(data: AppData, questionId: string): QuestionProgress | undefined {
  return data.progress.find((progress) => progress.questionId === questionId);
}

export function getProgress(data: AppData, questionId: string): QuestionProgress {
  return findProgress(data, questionId) ?? createInitialProgress(questionId);
}

export function getVirtualLevel(progress: QuestionProgress | undefined): 0 | 1 | 2 | 3 {
  if (!progress || progress.answeredCount === 0) return 0;
  return progress.reviewLevel ?? 1;
}

export function getEffectiveLevel(progress: QuestionProgress | undefined): EffectiveReviewLevel {
  if (!progress || progress.answeredCount === 0) return 0;
  if (progress.isGraduated) return 'graduated';
  return progress.reviewLevel ?? 1;
}

export function matchesReviewLevel(progress: QuestionProgress | undefined, selectedLevel: ReviewLevelFilter): boolean {
  if (selectedLevel === 'all') return progress?.isGraduated !== true;
  if (selectedLevel === 'level0') return !progress || progress.answeredCount === 0;
  if (!progress) return false;
  if (selectedLevel === 'level1') return progress.answeredCount > 0 && progress.reviewLevel === 1 && progress.isGraduated !== true;
  if (selectedLevel === 'level2') return progress.answeredCount > 0 && progress.reviewLevel === 2 && progress.isGraduated !== true;
  if (selectedLevel === 'level3') return progress.answeredCount > 0 && progress.reviewLevel === 3 && progress.isGraduated !== true;
  if (selectedLevel === 'ambiguous') return progress?.isAmbiguous === true && progress.isGraduated !== true;

  return true;
}

export function getProgressLevelLabel(progress: QuestionProgress | undefined): string {
  if (progress?.isGraduated) return '卒業';
  return `Level ${getVirtualLevel(progress)}`;
}

export function calculateStats(data: AppData): StudyStats {
  const totalCount = data.answerLogs.length;
  const correctCount = data.answerLogs.filter((log) => log.isCorrect).length;
  const todayCount = data.answerLogs.filter((log) => isToday(log.answeredAt)).length;
  const reviewCount = data.progress.filter(isReviewTarget).length;
  const ambiguousCount = data.progress.filter((progress) => progress.isAmbiguous).length;

  return {
    todayCount,
    totalCount,
    correctRate: totalCount === 0 ? 0 : Math.round((correctCount / totalCount) * 100),
    reviewCount,
    ambiguousCount,
  };
}

export function getQuestionsBySet(data: AppData, setId: string): Question[] {
  return data.questions.filter((question) => question.setId === setId);
}

export function getProblemSetsByFolder(data: AppData, folderId: string): ProblemSet[] {
  return data.problemSets.filter((set) => set.folderId === folderId);
}

export function getReviewQuestions(data: AppData): Question[] {
  const groups = groupReviewQuestionsByLevel(data, data.questions);
  return [
    ...shuffleArray(groups.ambiguous),
    ...shuffleArray(groups.level0),
    ...shuffleArray(groups.level1),
    ...shuffleArray(groups.level2),
    ...shuffleArray(groups.level3),
  ];
}

export function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function addFolder(data: AppData, name: string, parentFolderId?: string): AppData {
  if (parentFolderId && !data.folders.some((folder) => folder.id === parentFolderId && !folder.parentFolderId)) {
    throw new Error('子フォルダは親フォルダ直下にだけ作成できます。');
  }
  const timestamp = nowIso();
  const folder: Folder = {
    id: createId('folder'),
    name: name.trim(),
    ...(parentFolderId ? { parentFolderId } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ...data, folders: [folder, ...data.folders] };
}

export function deleteFolder(data: AppData, folderId: string): AppData {
  const folderIds = folderSubtreeIds(data.folders, folderId);
  const setIds = data.problemSets.filter((set) => folderIds.has(set.folderId)).map((set) => set.id);
  const questionIds = data.questions.filter((question) => setIds.includes(question.setId)).map((question) => question.id);

  return {
    ...data,
    folders: data.folders.filter((folder) => !folderIds.has(folder.id)),
    problemSets: data.problemSets.filter((set) => !folderIds.has(set.folderId)),
    questions: data.questions.filter((question) => !setIds.includes(question.setId)),
    progress: data.progress.filter((progress) => !questionIds.includes(progress.questionId)),
    answerLogs: data.answerLogs.filter((log) => !questionIds.includes(log.questionId) && !setIds.includes(log.setId) && !folderIds.has(log.folderId)),
  };
}

export function deleteProblemSet(data: AppData, setId: string): AppData {
  const questionIds = data.questions.filter((question) => question.setId === setId).map((question) => question.id);
  return {
    ...data,
    problemSets: data.problemSets.filter((set) => set.id !== setId),
    questions: data.questions.filter((question) => question.setId !== setId),
    progress: data.progress.filter((progress) => !questionIds.includes(progress.questionId)),
    answerLogs: data.answerLogs.filter((log) => log.setId !== setId),
  };
}

export function recordAnswer(
  data: AppData,
  question: Question,
  selectedIndexes: number[],
  isReviewMode: boolean,
  answerLogId = createId('log'),
): { data: AppData; isCorrect: boolean; addedToReview: boolean; progress: QuestionProgress } {
  const existingLog = data.answerLogs.find((log) => log.id === answerLogId);
  if (existingLog) {
    return {
      data,
      isCorrect: existingLog.isCorrect,
      addedToReview: false,
      progress: getProgress(data, question.id),
    };
  }
  const problemSet = data.problemSets.find((set) => set.id === question.setId);
  const folderId = problemSet?.folderId ?? '';
  const timestamp = nowIso();
  const answerIndexes = getAnswerIndexes(question);
  const isCorrect = answerIndexes.length > 0 && areSameIndexSet(selectedIndexes, answerIndexes);
  const existing = getProgress(data, question.id);
  const wasReviewTarget = existing.isReview && !existing.isGraduated;
  const wasUnanswered = existing.answeredCount === 0;
  const currentLevel = getVirtualLevel(existing);

  const nextProgress: QuestionProgress = {
    ...existing,
    answeredCount: existing.answeredCount + 1,
    correctCount: existing.correctCount + (isCorrect ? 1 : 0),
    wrongCount: existing.wrongCount + (isCorrect ? 0 : 1),
    lastSelectedIndex: selectedIndexes[0] ?? -1,
    lastAnswerCorrect: isCorrect,
    lastAnsweredAt: timestamp,
  };

  if (wasUnanswered) {
    nextProgress.isReview = true;
    nextProgress.isGraduated = false;
    nextProgress.reviewLevel = isCorrect ? 2 : 1;
  } else {
    if (isCorrect) {
      if (currentLevel >= 3) {
        nextProgress.isReview = false;
        nextProgress.isGraduated = true;
        nextProgress.reviewLevel = null;
      } else {
        nextProgress.isReview = true;
        nextProgress.isGraduated = false;
        nextProgress.reviewLevel = (currentLevel + 1) as 2 | 3;
      }
    } else {
      nextProgress.isReview = true;
      nextProgress.isGraduated = false;
      nextProgress.reviewLevel = Math.max(1, currentLevel - 1) as 1 | 2;
    }
  }

  const addedToReview = !isReviewMode && !wasReviewTarget && nextProgress.isReview && !nextProgress.isGraduated;

  const nextProgressList = upsertProgress(data.progress, nextProgress);
  const nextLog = {
    id: answerLogId,
    questionId: question.id,
    setId: question.setId,
    folderId,
    selectedIndex: selectedIndexes[0] ?? -1,
    selectedIndexes,
    isCorrect,
    answeredAt: timestamp,
  };

  return {
    data: {
      ...data,
      progress: nextProgressList,
      answerLogs: [...data.answerLogs, nextLog],
    },
    isCorrect,
    addedToReview,
    progress: nextProgress,
  };
}

export function getAnswerIndexes(question: Question): number[] {
  if (Array.isArray(question.answerIndexes) && question.answerIndexes.length > 0) {
    return normalizeIndexes(question.answerIndexes).filter((index) => index >= 0 && index < question.choices.length);
  }
  return question.answerIndex >= 0 && question.answerIndex < question.choices.length ? [question.answerIndex] : [];
}

export function getAnswerText(question: Question): string {
  return getAnswerIndexes(question)
    .map((index) => `${getChoiceLabel(index)}. ${getChoiceText(question, index)}`)
    .join('\n');
}

export function getChoiceLabel(index: number) {
  return String(index + 1);
}

export function getChoiceText(question: Question, index: number) {
  return stripChoicePrefix(question.choices[index] ?? '');
}

export function stripChoicePrefix(text: string) {
  return text.replace(/^\s*(?:[A-EＡ-Ｅａ-ｅa-e]|[1-5１-５])\s*[\.\)\]:：．）]\s*/u, '').trim();
}

function areSameIndexSet(a: number[], b: number[]) {
  const left = normalizeIndexes(a);
  const right = normalizeIndexes(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeIndexes(indexes: number[]) {
  return Array.from(new Set(indexes)).sort((a, b) => a - b);
}

export function toggleAmbiguous(data: AppData, questionId: string): AppData {
  const existing = getProgress(data, questionId);
  const nextIsAmbiguous = !existing.isAmbiguous;
  const isUnanswered = existing.answeredCount === 0;
  const nextProgress: QuestionProgress = {
    ...existing,
    isAmbiguous: nextIsAmbiguous,
    isReview: nextIsAmbiguous ? true : (isUnanswered ? false : existing.isReview),
    isGraduated: nextIsAmbiguous ? false : existing.isGraduated,
    reviewLevel: nextIsAmbiguous ? (isUnanswered ? existing.reviewLevel : existing.reviewLevel ?? 1) : existing.reviewLevel,
  };
  return { ...data, progress: upsertProgress(data.progress, nextProgress) };
}

export function updateQuestionDetailedExplanation(data: AppData, questionId: string, detailedExplanation: string): AppData {
  const updatedAt = nowIso();
  return { ...data, questions: data.questions.map((question) => question.id === questionId ? {
    ...question, detailedExplanation, updatedAt,
    detailedAnswer: { body: detailedExplanation, imageIds: question.detailedAnswer?.imageIds ?? [], updatedAt },
  } : question) };
}

export function groupReviewQuestionsByLevel(data: AppData, questions: Question[]) {
  const groups: Record<'ambiguous' | 'level0' | 'level1' | 'level2' | 'level3', Question[]> = {
    ambiguous: [],
    level0: [],
    level1: [],
    level2: [],
    level3: [],
  };

  questions.forEach((question) => {
    const progress = getProgress(data, question.id);
    if (!isReviewTarget(progress)) return;
    if (progress.isAmbiguous) {
      groups.ambiguous.push(question);
      return;
    }
    const level = getEffectiveLevel(progress);
    if (level === 0) groups.level0.push(question);
    if (level === 1) groups.level1.push(question);
    if (level === 2) groups.level2.push(question);
    if (level === 3) groups.level3.push(question);
  });

  return groups;
}

export function makeResult(mode: 'quiz' | 'review', title: string, setId: string | undefined, correct: number, wrong: number, addedReviewCount: number): QuizResult {
  return {
    mode,
    title,
    setId,
    answered: correct + wrong,
    correct,
    wrong,
    addedReviewCount,
  };
}

function upsertProgress(list: QuestionProgress[], item: QuestionProgress): QuestionProgress[] {
  const exists = list.some((progress) => progress.questionId === item.questionId);
  if (!exists) return [...list, item];
  return list.map((progress) => (progress.questionId === item.questionId ? item : progress));
}
