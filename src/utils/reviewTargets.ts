import type { QuestionProgress } from '../types';

export function isReviewTarget(progress: QuestionProgress | undefined, now = new Date()): boolean {
  return isReviewDue(progress, now);
}

export function getReviewIntervalDays(progress: QuestionProgress): number {
  // A wrong or uncertain answer returns to the shortest interval.
  if (progress.lastAnswerCorrect === false || progress.isAmbiguous) return 1;
  return progress.reviewLevel === 3 ? 7 : progress.reviewLevel === 2 ? 3 : 1;
}

export function getReviewDueAt(progress: QuestionProgress): number | null {
  if (!progress.lastAnsweredAt) return null;
  const last = new Date(progress.lastAnsweredAt);
  if (!Number.isFinite(last.getTime())) return null;
  return new Date(last.getFullYear(), last.getMonth(), last.getDate() + getReviewIntervalDays(progress)).getTime();
}

export function isReviewCandidate(progress: QuestionProgress | undefined): boolean {
  return Boolean(
    progress
    && progress.answeredCount > 0
    && (progress.isReview || progress.isAmbiguous)
    && !progress.isGraduated
    && !progress.isStudyCompleted
  );
}

export function isReviewDue(progress: QuestionProgress | undefined, now = new Date()): boolean {
  return Boolean(
    progress
    && isReviewCandidate(progress)
    && (getReviewDueAt(progress) ?? Number.NEGATIVE_INFINITY) <= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  );
}
