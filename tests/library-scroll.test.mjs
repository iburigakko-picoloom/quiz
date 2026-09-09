import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('public and group libraries share a bounded scroll container', () => {
  const source = readFileSync(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/final-reference.css', import.meta.url), 'utf8');
  assert.match(source, /className="community-group-folder-list community-library-scroll"/);
  assert.match(source, /className="community-library-scroll" aria-label="公開ライブラリ" tabIndex=\{0\}/);
  assert.match(css, /community-library-scroll:not\(\[hidden\]\)[^{]*\{[^}]*min-height: 0;[^}]*overflow-y: auto/);
  assert.match(css, /community-screen__header \{ flex-shrink: 0;/);
});
