import assert from 'node:assert/strict';
import test from 'node:test';
import { getLineAvatarUrl } from '../src/utils/lineAvatar.ts';

const provider = 'custom:quizmake-line';
const user = (identity_data, source = provider) => ({ identities: [{ provider: source, identity_data }] });
test('uses the linked Quiz Make LINE picture, not another provider', () => {
  assert.equal(getLineAvatarUrl(user({ picture: 'https://profile.line-scdn.net/example' }), provider), 'https://profile.line-scdn.net/example');
  assert.equal(getLineAvatarUrl(user({ picture: 'https://example.com/avatar' }, 'custom:line'), provider), null);
  assert.equal(getLineAvatarUrl({ identities: [] }, provider), null);
});
test('missing and unsafe images fall back safely', () => {
  for (const picture of [null, 123, '', 'bad', 'http://example.com/a', 'javascript:alert(1)', 'data:image/png;base64,a', 'https://user:password@example.com/a']) {
    assert.equal(getLineAvatarUrl(user({ picture }), provider), null);
  }
  assert.equal(getLineAvatarUrl(user({ avatar_url: 'https://example.com/a' }), provider), 'https://example.com/a');
});
