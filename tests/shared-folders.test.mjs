import test from 'node:test';
import assert from 'node:assert/strict';
import { localFolderPath, sharedFolderTree, folderSets } from '../src/utils/sharedFolders.ts';
test('publication retains the root and child folder identities', () => {
  assert.deepEqual(localFolderPath([{ id: 'root', name: '英語' }, { id: 'child', name: '単語', parentFolderId: 'root' }], 'child'), [{ id: 'root', name: '英語' }, { id: 'child', name: '単語' }]);
});
test('same folder names and ids from different owners never merge', () => {
  const folderPath = [{ id: 'root', name: '英語' }, { id: 'child', name: '単語' }];
  const sets = [{ id: 'a', ownerId: 'one', authorName: 'One', folderPath }, { id: 'b', ownerId: 'two', authorName: 'Two', folderPath }, { id: 'c', ownerId: 'one', authorName: 'One' }];
  const tree = sharedFolderTree(sets);
  assert.equal(tree.folders.length, 2);
  assert.deepEqual(folderSets(tree.folders[0]).map((set) => set.id), ['a']);
  assert.equal(tree.folders[0].folders[0].name, '単語');
  assert.deepEqual(tree.sets.map((set) => set.id), ['c']);
});
