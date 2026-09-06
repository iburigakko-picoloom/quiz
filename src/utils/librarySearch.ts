import type { AppData } from '../types';
import { folderSubtreeIds } from './folderHierarchy';
export function normalizeSearch(value: string): string { return value.trim().normalize('NFKC').toLocaleLowerCase('en'); }
export function searchLibrary(data: AppData, text: string, folderId = '', category = '') {
  const query = normalizeSearch(text);
  const folders = folderId ? folderSubtreeIds(data.folders, folderId) : null;
  const eligibleSets = data.problemSets.filter((set) => !folders || folders.has(set.folderId));
  const setIds = new Set(eligibleSets.map((set) => set.id));
  return {
    sets: eligibleSets.filter((set) => normalizeSearch(set.title).includes(query)),
    questions: data.questions.filter((question) => setIds.has(question.setId) && (!category || question.category === category))
      .flatMap((question) => {
        const bodyMatch = normalizeSearch(question.question).includes(query);
        const choiceMatch = question.choices.some((choice) => normalizeSearch(choice).includes(query));
        return bodyMatch || choiceMatch ? [{ question, choiceOnly: !bodyMatch }] : [];
      }),
  };
}
