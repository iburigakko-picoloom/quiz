import type { AppData } from '../types';
import { folderSubtreeIds } from './folderHierarchy';
export function normalizeSearch(value: string): string { return value.trim().normalize('NFKC').toLocaleLowerCase('en'); }
export function buildLibrarySearchIndex(data: AppData) {
  const questionCounts = new Map<string, number>();
  const sets = data.problemSets.map(set => ({ set, text: normalizeSearch(set.title) }));
  const questions = data.questions.map(question => {
    questionCounts.set(question.setId, (questionCounts.get(question.setId) ?? 0) + 1);
    return { question, body: normalizeSearch(question.question), choices: question.choices.map(normalizeSearch) };
  });
  return { sets, questions, questionCounts };
}
export function searchLibrary(data: AppData, text: string, folderId = '', category = '', index = buildLibrarySearchIndex(data)) {
  const query = normalizeSearch(text);
  const folders = folderId ? folderSubtreeIds(data.folders, folderId) : null;
  const eligibleSets = index.sets.filter(({ set }) => !folders || folders.has(set.folderId));
  const setIds = new Set(eligibleSets.map(({ set }) => set.id));
  return {
    sets: eligibleSets.filter(({ text }) => text.includes(query)).map(({ set }) => set),
    questions: index.questions.filter(({ question }) => setIds.has(question.setId) && (!category || question.category === category))
      .flatMap(({ question, body, choices }) => {
        const bodyMatch = body.includes(query);
        const choiceMatch = choices.some(choice => choice.includes(query));
        return bodyMatch || choiceMatch ? [{ question, choiceOnly: !bodyMatch }] : [];
      }),
  };
}
