import type {
  AppData,
  Folder,
  ProblemSet,
  ProblemSortMode,
  Question,
  QuestionProgress,
} from '../types';
import { createInitialProgress, getVirtualLevel } from './quiz';
import { isReviewTarget } from './reviewTargets';

export interface CollectionSummary {
  questionCount: number;
  reviewCount: number;
  correctRate: number;
}

export interface FolderOverview extends CollectionSummary {
  folder: Folder;
  setCount: number;
}

export interface ProblemSetOverview extends CollectionSummary {
  problemSet: ProblemSet;
}

export interface QuestionOverview {
  question: Question;
  number: number;
  progress: QuestionProgress;
}

export interface AppDataView {
  folderById: ReadonlyMap<string, Folder>;
  problemSetById: ReadonlyMap<string, ProblemSet>;
  folders: readonly FolderOverview[];
  problemSetsByFolderId: ReadonlyMap<string, readonly ProblemSetOverview[]>;
  questionsBySetId: ReadonlyMap<string, readonly QuestionOverview[]>;
}

interface MutableCollectionSummary {
  questionCount: number;
  reviewCount: number;
  answerCount: number;
  correctCount: number;
}

interface MutableFolderSummary extends MutableCollectionSummary {
  setCount: number;
}

function createCollectionSummary(): MutableCollectionSummary {
  return {
    questionCount: 0,
    reviewCount: 0,
    answerCount: 0,
    correctCount: 0,
  };
}

function finishCollectionSummary(summary: MutableCollectionSummary): CollectionSummary {
  return {
    questionCount: summary.questionCount,
    reviewCount: summary.reviewCount,
    correctRate: summary.answerCount === 0
      ? 0
      : Math.round((summary.correctCount / summary.answerCount) * 100),
  };
}

function appendToMapList<T>(map: Map<string, T[]>, key: string, item: T) {
  const existing = map.get(key);
  if (existing) {
    existing.push(item);
  } else {
    map.set(key, [item]);
  }
}

/**
 * Builds the read model shared by the library screens in linear passes.
 *
 * Counts follow canonical question -> problem set -> folder relationships rather
 * than the denormalized ids on answer logs. This keeps legacy logs whose parent
 * ids are stale usable, while excluding records whose question no longer exists.
 */
export function buildAppDataView(data: AppData): AppDataView {
  const folderById = new Map<string, Folder>();
  const problemSetById = new Map<string, ProblemSet>();
  const progressByQuestionId = new Map<string, QuestionProgress>();
  const folderSummaries = new Map<string, MutableFolderSummary>();
  const setSummaries = new Map<string, MutableCollectionSummary>();
  const problemSetsByFolderId = new Map<string, ProblemSet[]>();
  const questionsBySetId = new Map<string, QuestionOverview[]>();
  const canonicalQuestionById = new Map<string, Question>();
  const questionCountBySetId = new Map<string, number>();

  for (const folder of data.folders) {
    if (!folderById.has(folder.id)) folderById.set(folder.id, folder);
    if (!folderSummaries.has(folder.id)) {
      folderSummaries.set(folder.id, { ...createCollectionSummary(), setCount: 0 });
    }
  }

  for (const progress of data.progress) {
    // App-data validation rejects duplicate ids. Keeping the first entry here also
    // matches the historical `Array.find` behavior for data already in memory.
    if (!progressByQuestionId.has(progress.questionId)) {
      progressByQuestionId.set(progress.questionId, progress);
    }
  }

  for (const problemSet of data.problemSets) {
    if (!problemSetById.has(problemSet.id)) problemSetById.set(problemSet.id, problemSet);
    if (!setSummaries.has(problemSet.id)) setSummaries.set(problemSet.id, createCollectionSummary());
    appendToMapList(problemSetsByFolderId, problemSet.folderId, problemSet);
    const folderSummary = folderSummaries.get(problemSet.folderId);
    if (folderSummary) folderSummary.setCount += 1;
  }

  for (const question of data.questions) {
    const problemSet = problemSetById.get(question.setId);
    const setSummary = setSummaries.get(question.setId);
    if (!problemSet || !setSummary) continue;

    const number = (questionCountBySetId.get(question.setId) ?? 0) + 1;
    questionCountBySetId.set(question.setId, number);
    if (!canonicalQuestionById.has(question.id)) canonicalQuestionById.set(question.id, question);

    const progress = progressByQuestionId.get(question.id) ?? createInitialProgress(question.id);
    appendToMapList(questionsBySetId, question.setId, { question, number, progress });

    const reviewTarget = isReviewTarget(progress);
    setSummary.questionCount += 1;
    if (reviewTarget) setSummary.reviewCount += 1;

    const folderSummary = folderSummaries.get(problemSet.folderId);
    if (folderSummary) {
      folderSummary.questionCount += 1;
      if (reviewTarget) folderSummary.reviewCount += 1;
    }
  }

  for (const log of data.answerLogs) {
    const question = canonicalQuestionById.get(log.questionId);
    if (!question) continue;
    const problemSet = problemSetById.get(question.setId);
    const setSummary = setSummaries.get(question.setId);
    if (!problemSet || !setSummary) continue;

    setSummary.answerCount += 1;
    if (log.isCorrect) setSummary.correctCount += 1;

    const folderSummary = folderSummaries.get(problemSet.folderId);
    if (folderSummary) {
      folderSummary.answerCount += 1;
      if (log.isCorrect) folderSummary.correctCount += 1;
    }
  }

  for (const folder of data.folders) {
    if (!folder.parentFolderId) continue;
    const parent = folderSummaries.get(folder.parentFolderId);
    const child = folderSummaries.get(folder.id);
    if (!parent || !child || folderById.get(folder.parentFolderId)?.parentFolderId) continue;
    parent.setCount += child.setCount;
    parent.questionCount += child.questionCount;
    parent.reviewCount += child.reviewCount;
    parent.answerCount += child.answerCount;
    parent.correctCount += child.correctCount;
  }

  const folders = data.folders.map((folder): FolderOverview => {
    const summary = folderSummaries.get(folder.id) ?? { ...createCollectionSummary(), setCount: 0 };
    return {
      folder,
      setCount: summary.setCount,
      ...finishCollectionSummary(summary),
    };
  });

  const problemSetOverviewsByFolderId = new Map<string, readonly ProblemSetOverview[]>();
  for (const [folderId, problemSets] of problemSetsByFolderId) {
    problemSetOverviewsByFolderId.set(folderId, problemSets.map((problemSet) => ({
      problemSet,
      ...finishCollectionSummary(setSummaries.get(problemSet.id) ?? createCollectionSummary()),
    })));
  }

  return {
    folderById,
    problemSetById,
    folders,
    problemSetsByFolderId: problemSetOverviewsByFolderId,
    questionsBySetId,
  };
}

export function sortQuestionOverviews(
  questions: readonly QuestionOverview[],
  sortMode: ProblemSortMode,
): QuestionOverview[] {
  if (sortMode === 'ordered') return [...questions];
  return [...questions].sort((left, right) => (
    getProblemListSortScore(left.progress) - getProblemListSortScore(right.progress)
  ));
}

function getProblemListSortScore(progress: QuestionProgress) {
  if (progress.isAmbiguous) return 0;
  if (progress.isGraduated) return 5;
  const level = getVirtualLevel(progress);
  if (level === 0) return 1;
  if (level === 1) return 2;
  if (level === 2) return 3;
  return 4;
}
