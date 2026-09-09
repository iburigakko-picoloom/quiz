import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('shared copies require a chosen existing folder without creating a default folder', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const copy = app.slice(app.indexOf('const handleCopySharedProblemSet'), app.indexOf('const handlePracticeSharedProblemSet'));
  assert.match(copy, /targetFolderId: string/);
  assert.match(copy, /current.folders.some\(\(folder\) => folder.id === targetFolderId\)/);
  assert.match(copy, /folderId: targetFolderId/);
  assert.doesNotMatch(copy, /createId\('folder'\)|追加した問題セット/);
  const screen = readFileSync(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8');
  assert.match(screen, /onCopySharedSet\(detail, copyFolderId\)/);
  assert.match(screen, /copyBusyRef.current/);
  assert.match(screen, /folder.parentFolderId/);
});
