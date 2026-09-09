import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('folder content remains mounted for closing and is inert when collapsed', () => {
  const source = readFileSync(new URL('../src/screens/FolderScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /expanded === child.id \? <div/);
  assert.match(source, /inert=\{expanded !== child.id\}/);
  assert.match(source, /aria-hidden=\{expanded !== child.id\}/);
  const css = readFileSync(new URL('../src/screens/FolderScreen.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-rows: 0fr/);
  assert.match(css, /grid-template-rows: 1fr/);
  assert.match(css, /transition: grid-template-rows 240ms/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
