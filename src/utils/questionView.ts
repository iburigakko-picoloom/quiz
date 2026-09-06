import type { Question } from '../types';

export function resolveQuestionDetailedExplanation(
  questions: Question[],
  sessionQuestion: Question | undefined,
): string {
  if (!sessionQuestion) return '';
  const persistedQuestion = questions.find((question) => question.id === sessionQuestion.id);
  return persistedQuestion
    ? persistedQuestion.detailedAnswer?.body ?? persistedQuestion.detailedExplanation ?? ''
    : sessionQuestion.detailedAnswer?.body ?? sessionQuestion.detailedExplanation ?? '';
}
