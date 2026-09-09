import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8');
const linking = source.slice(source.indexOf('export async function linkLineIdentity'), source.indexOf('export async function signInWithLine'));
test('LINE linking verifies the current user and never starts a new login or deletes data', () => {
  assert.match(linking, /auth\.getUser\(\)/);
  assert.match(linking, /auth\.linkIdentity\(/);
  assert.match(linking, /provider: lineAuthProvider/);
  assert.doesNotMatch(linking, /signInWithOAuth|signOut|removeItem|clear\(/);
  assert.match(linking, /manual_linking_disabled/);
  assert.match(linking, /identity_already_exists/);
});

test('LINE status queries the server and distinguishes unlinked from failed checks', async () => {
  const statusSource = source.slice(source.indexOf('export async function getLineLinkStatus'), source.indexOf('export async function linkLineIdentity'));
  let response;
  let calls = 0;
  const getStatus = new Function('requireCloudClient', 'lineAuthProvider', `${stripTypeScriptTypes(statusSource.replace('export ', ''))}; return getLineLinkStatus;`)(() => ({ auth: { getUser: async () => { calls++; return response; } } }), 'custom:quizmake-line');
  response = { data: { user: { id: 'current', identities: [{ provider: 'custom:line' }] } }, error: null };
  assert.equal(await getStatus('current'), false, 'shared LINE identity is not a Quiz Make link');
  response.data.user.identities = [{ provider: 'custom:quizmake-line' }];
  assert.equal(await getStatus('current'), true);
  response.data.user.identities = [{ provider: 'email' }];
  assert.equal(await getStatus('current'), false);
  await assert.rejects(getStatus('different'), /確認できません/);
  response = { data: { user: null }, error: new Error('network') };
  await assert.rejects(getStatus('current'), /確認できません/);
  assert.equal(calls, 5);
});

test('LINE UI refreshes on return and has timeout, retry and stale-response guards', () => {
  const button = readFileSync(new URL('../src/components/LineLoginButton.tsx', import.meta.url), 'utf8');
  for (const text of ['確認中', 'LINE連携済み', '未連携', '確認できませんでした', '再確認', 'visibilitychange', 'pageshow']) assert.ok(button.includes(text));
  assert.match(button, /getLineLinkStatus\(userId\)/);
  assert.match(button, /12000/);
  assert.match(button, /request === revision.current/);
  assert.match(button, /if \(linked\).*setStatus\('linked'\)/);
});
