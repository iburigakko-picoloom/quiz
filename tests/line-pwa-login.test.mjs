import test from 'node:test';
import assert from 'node:assert/strict';
import { lineWebLoginQuery } from '../src/utils/linePwaLogin.ts';
import { readFileSync } from 'node:fs';
test('iPad desktop mode and iPhone standalone use LINE web authentication', () => {
  for (const environment of [
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5, standalone: true },
    { userAgent: 'Mozilla/5.0 (iPad)', platform: 'iPad', maxTouchPoints: 5, standalone: true },
    { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5, standalone: true },
  ]) assert.deepEqual(lineWebLoginQuery(environment), { disable_auto_login: 'true', prompt: 'login' });
});
test('normal Safari, Mac and Android keep their existing login flow', () => {
  for (const environment of [
    { userAgent: 'iPad', platform: 'MacIntel', maxTouchPoints: 5, standalone: false },
    { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0, standalone: true },
    { userAgent: 'Android', platform: 'Linux', maxTouchPoints: 5, standalone: true },
  ]) assert.equal(lineWebLoginQuery(environment), undefined);
});
test('both sign in and account linking apply the web-flow parameters', () => {
  const source = readFileSync('src/utils/cloudService.ts', 'utf8');
  assert.equal(source.match(/queryParams: lineWebLoginQuery\(\)/g)?.length, 2);
});
