import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8');
const linking = source.slice(source.indexOf('export async function linkLineIdentity'), source.indexOf('export async function signInWithLine'));
test('LINE linking verifies the current user and never starts a new login or deletes data', () => {
  assert.match(linking, /auth\.getUser\(\)/);
  assert.match(linking, /auth\.linkIdentity\(/);
  assert.match(linking, /provider: 'custom:line'/);
  assert.doesNotMatch(linking, /signInWithOAuth|signOut|removeItem|clear\(/);
  assert.match(linking, /manual_linking_disabled/);
  assert.match(linking, /identity_already_exists/);
});
