import type { Question } from '../types';

export const ALL_CATEGORIES = 'すべて';
const UNCATEGORIZED = '未分類';

export function normalizeProblemCategory(category: string | null | undefined) {
  return category?.trim() || UNCATEGORIZED;
}

export function filterQuestionsByCategory(questions: Question[], category: string) {
  if (category === 'all' || category === ALL_CATEGORIES) return questions;
  return questions.filter((question) => normalizeProblemCategory(question.category) === category);
}

export function buildProblemCategories(questions: Question[]) {
  const names = new Set(questions.map((question) => normalizeProblemCategory(question.category)));
  const hasUncategorized = names.delete(UNCATEGORIZED);
  return [ALL_CATEGORIES, ...names, ...(hasUncategorized ? [UNCATEGORIZED] : [])];
}
