import test from 'node:test';
import assert from 'node:assert/strict';
import { beginLineLinkAttempt, readLineLinkAttempt, clearLineLinkAttempt, lineAuthErrorMessage } from '../src/utils/lineAuthReturn.ts';

test('LINE attempt stores only account and expiry and clears only its own marker', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map([['unrelated', 'keep']]);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) } });
  try {
    beginLineLinkAttempt('current-user');
    assert.equal(readLineLinkAttempt()?.userId, 'current-user');
    assert.deepEqual(Object.keys(readLineLinkAttempt()).sort(), ['startedAt', 'userId']);
    clearLineLinkAttempt();
    assert.equal(readLineLinkAttempt(), null);
    assert.equal(values.get('unrelated'), 'keep');
    values.set('quiz-make-line-link-attempt', JSON.stringify({ userId: 'old', startedAt: Date.now() - 21 * 60 * 1000 }));
    assert.equal(readLineLinkAttempt(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  }
});

test('callback errors are mapped without echoing untrusted or secret text', () => {
  assert.match(lineAuthErrorMessage('identity_already_exists'), /別のアカウント/);
  assert.match(lineAuthErrorMessage('access_denied'), /許可されなかった/);
  assert.match(lineAuthErrorMessage('bad_oauth_state'), /有効期限/);
  assert.doesNotMatch(lineAuthErrorMessage('secret=private-token'), /private-token/);
});
