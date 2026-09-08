import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { folderSubtreeIds } from '../src/utils/folderHierarchy.ts';

test('folder publishing includes descendants but no sibling folders', () => {
  const folders = [{ id: 'root' }, { id: 'child', parentFolderId: 'root' }, { id: 'other' }];
  assert.deepEqual([...folderSubtreeIds(folders, 'root')], ['root', 'child']);
});
test('public and group entry points make the audience explicit before publishing', () => {
  const source = readFileSync(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /openAdd\('public'\)/);
  assert.match(source, /openAdd\('group'\)/);
  assert.match(source, /公開先：\{addTarget.name\}/);
  assert.match(source, /groupIds: target.groupId \? \[target.groupId\] : \[\]/);
  assert.match(source, /addBusyRef.current/);
  assert.match(source, /setAddResults\(\{ \.\.\.results \}\)/);
  assert.match(source, /既に共有中のセットは公開先が変更されます/);
});
