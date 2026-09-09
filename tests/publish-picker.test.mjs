import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const screen = readFileSync(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../src/components/PublishPicker.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/PublishPicker.css', import.meta.url), 'utf8');
test('public publish action is outside the collapsed discovery filter', () => {
  const filter = screen.slice(screen.indexOf('<details className="community-discovery-filter"'));
  assert.ok(filter.indexOf('</details>') < filter.indexOf("openAdd('public')"));
});
test('picker separates opening from selection and confirms before publishing', () => {
  assert.match(picker, /indeterminate = partial/);
  assert.match(picker, /folderSubtreeIds\(data.folders, folder.id\)/);
  assert.match(picker, /aria-expanded=\{open\}/);
  assert.match(picker, /inert=\{!open\}/);
  assert.match(screen, /if \(!addReview\) setAddReview\(true\); else void submitAdd\(\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /grid-template-rows 240ms/);
});
