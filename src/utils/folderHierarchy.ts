import type { AppData, Folder } from '../types';

/** Invalid relationships are detached, never content records deleted. */
export function normalizeFolderHierarchy(folders: Folder[]): Folder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.map((folder) => {
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
    if (!folder.parentFolderId || (parent && parent.id !== folder.id && !parent.parentFolderId)) return folder;
    const { parentFolderId: _parent, ...root } = folder;
    return root;
  });
}

export function folderSubtreeIds(folders: readonly Folder[], folderId: string): Set<string> {
  const ids = new Set([folderId]);
  // Also cleans up legacy malformed trees without leaving descendants orphaned.
  let previousSize = 0;
  while (previousSize !== ids.size) {
    previousSize = ids.size;
    for (const folder of folders) if (folder.parentFolderId && ids.has(folder.parentFolderId)) ids.add(folder.id);
  }
  return ids;
}

export function canMoveFolder(folders: readonly Folder[], id: string, parentId?: string): boolean {
  const folder = folders.find((item) => item.id === id);
  if (!folder || id === parentId) return false;
  if (!parentId) return true;
  const parent = folders.find((item) => item.id === parentId);
  return !!parent && !parent.parentFolderId && !folders.some((item) => item.parentFolderId === id);
}

export function moveFolder(data: AppData, id: string, parentId?: string): AppData {
  if (!canMoveFolder(data.folders, id, parentId)) throw new Error('このフォルダには移動できません。');
  return { ...data, folders: data.folders.map((folder) => folder.id === id
    ? { ...folder, parentFolderId: parentId, updatedAt: new Date().toISOString() } : folder) };
}

export function moveProblemSet(data: AppData, setId: string, folderId: string): AppData {
  if (!data.folders.some((folder) => folder.id === folderId) || !data.problemSets.some((set) => set.id === setId)) {
    throw new Error('移動元または移動先が見つかりません。');
  }
  const questionIds = new Set(data.questions.filter((question) => question.setId === setId).map((question) => question.id));
  return {
    ...data,
    problemSets: data.problemSets.map((set) => set.id === setId ? { ...set, folderId, updatedAt: new Date().toISOString() } : set),
    answerLogs: data.answerLogs.map((log) => questionIds.has(log.questionId) ? { ...log, setId, folderId } : log),
  };
}

export function folderChoices(folders: readonly Folder[]): Folder[] {
  return folders.filter((folder) => !folder.parentFolderId).flatMap((parent) => [
    parent, ...folders.filter((folder) => folder.parentFolderId === parent.id),
  ]);
}
