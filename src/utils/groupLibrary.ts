import type { CloudProblemSet } from './cloudService';
import type { GroupLearningSnapshot, GroupSharedFolder } from './groupLearningService';
import { folderSets, sharedFolderTree, type SharedFolderPart } from './sharedFolders';

export interface GroupFolderCardData {
  key: string;
  id?: string;
  name: string;
  creatorName: string;
  createdBy?: string | null;
  updatedAt: string;
  importCount: number | null;
  sets: CloudProblemSet[];
  children: GroupFolderCardData[];
  legacyPath?: SharedFolderPart[];
}
export function buildGroupLibrary(sets: CloudProblemSet[], snapshot: GroupLearningSnapshot | null): GroupFolderCardData[] {
  const folders = snapshot?.folders ?? [];
  const placements = new Map(snapshot?.placements.map(row => [row.setId, row.folderId]) ?? []);
  const ids = new Set(folders.map(folder => folder.id));
  const build = (folder: GroupSharedFolder): GroupFolderCardData => {
    const children = folders.filter(child => child.parentId === folder.id).map(build);
    const contents = sets.filter(set => placements.get(set.id) === folder.id);
    return { key: `group:${folder.id}`, id: folder.id, name: folder.name, creatorName: folder.creatorName, createdBy: folder.createdBy, updatedAt: folder.updatedAt, importCount: folder.importCount, sets: contents, children };
  };
  const roots = folders.filter(folder => !folder.parentId || !ids.has(folder.parentId)).map(build);
  const unplaced = sets.filter(set => !placements.get(set.id) || !ids.has(placements.get(set.id)!));
  const tree = sharedFolderTree(unplaced);
  const legacy = (node: typeof tree.folders[number], parentPath: SharedFolderPart[] = []): GroupFolderCardData => {
    const legacyPath = [...parentPath, { id: node.id, name: node.name }];
    const contents = folderSets(node);
    return { key: node.key, name: node.name, creatorName: node.authorName, createdBy: node.ownerId, updatedAt: contents.map(set => set.updatedAt).sort().slice(-1)[0] ?? '', importCount: null, sets: node.sets, children: node.folders.map(child => legacy(child, legacyPath)), legacyPath };
  };
  return [...roots, ...tree.folders.map(node => legacy(node)), ...(tree.sets.length ? [{ key: 'unfiled', name: '未分類', creatorName: 'グループの共有セット', updatedAt: tree.sets.map(set => set.updatedAt).sort().slice(-1)[0] ?? '', importCount: null, sets: tree.sets, children: [] }] : [])];
}
export function groupFolderSets(folder: GroupFolderCardData): CloudProblemSet[] {
  return [...folder.sets, ...folder.children.flatMap(groupFolderSets)];
}
