import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/components/WelcomeGuide.tsx', import.meta.url), 'utf8');
test('welcome guide is dismissible and respects login and installation state', () => {
  assert.match(source, /localStorage.setItem\(SEEN_KEY, 'done'\)/);
  assert.match(source, /!signedIn && lineLoginAvailable/);
  assert.match(source, /!isInstalled/);
  assert.match(source, /あとで・このまま使う/);
  assert.match(source, /ホーム画面に追加する/);
  assert.doesNotMatch(source, /PWA化|signOut|clear\(\)/);
});
test('installation is initiated only by an explicit button action', () => {
  assert.match(source, /onClick=\{async \(\) => \{[\s\S]*await installEvent.prompt\(\)/);
  assert.match(source, /window.removeEventListener\('beforeinstallprompt'/);
  assert.match(source, /onCancel=\{dismiss\}/);
});
