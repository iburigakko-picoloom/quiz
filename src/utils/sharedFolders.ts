import type { Folder } from '../types';
import type { CloudProblemSet } from './cloudService';
export interface SharedFolderPart { id: string; name: string }
export interface SharedFolderNode { key: string; id: string; name: string; ownerId: string; authorName: string; folders: SharedFolderNode[]; sets: CloudProblemSet[] }
export function localFolderPath(folders: Folder[], folderId: string): SharedFolderPart[] {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return [];
  const parent = folders.find((item) => item.id === folder.parentFolderId);
  return [...(parent ? [parent] : []), folder].map(({ id, name }) => ({ id, name }));
}
export function sharedFolderTree(sets: CloudProblemSet[]) {
  const root: { folders: SharedFolderNode[]; sets: CloudProblemSet[] } = { folders: [], sets: [] };
  for (const set of sets) {
    let level = root;
    let key = set.ownerId;
    for (const part of set.folderPath ?? []) {
      key += `/${part.id}`;
      let node = level.folders.find((item) => item.key === key);
      if (!node) { node = { key, ...part, ownerId: set.ownerId, authorName: set.authorName, folders: [], sets: [] }; level.folders.push(node); }
      level = node;
    }
    level.sets.push(set);
  }
  return root;
}
export function folderSets(node: SharedFolderNode): CloudProblemSet[] { return [...node.sets, ...node.folders.flatMap(folderSets)]; }
