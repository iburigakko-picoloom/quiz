import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const nativeAuth = await import('../src/utils/nativeAuth.ts');

const {
  NATIVE_AUTH_REDIRECT_URL,
  beginNativeAuthAttempt,
  consumeNativeAuthReturnTarget,
  handleNativeAuthUrl,
  onNativeAuthResult,
  parseNativeAuthCallback,
  rememberNativeAuthReturnTarget,
} = nativeAuth;

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('native login returns to a validated sync child without restoring a destructive action', () => {
  const storage = createStorage();
  for (const page of ['settings', 'recovery', 'connect', 'diagnostics', 'danger']) {
    assert.equal(rememberNativeAuthReturnTarget({ name: 'sync', page, pendingDelete: true }, storage, 1000), true);
    assert.deepEqual(consumeNativeAuthReturnTarget(storage, 1001), { name: 'sync', page });
  }
  assert.equal(rememberNativeAuthReturnTarget({ name: 'sync', page: 'untrusted' }, storage, 1000), false);
  assert.equal(consumeNativeAuthReturnTarget(storage, 1001), null);
});

test('native callback accepts only the exact app-owned PKCE route', () => {
  assert.deepEqual(
    parseNativeAuthCallback(`${NATIVE_AUTH_REDIRECT_URL}?code=abcDEF12-._~&sb_flow_id=0123456789abcdef`),
    { kind: 'pkce', code: 'abcDEF12-._~', flowId: '0123456789abcdef' },
  );

  for (const url of [
    'other.app://login-callback/?code=abcdefgh',
    'io.github.manatocookietwitterlang.quizmake.auth://other-host/?code=abcdefgh',
    'io.github.manatocookietwitterlang.quizmake.auth://login-callback/other?code=abcdefgh',
    'io.github.manatocookietwitterlang.quizmake.auth://user@login-callback/?code=abcdefgh',
  ]) {
    assert.deepEqual(parseNativeAuthCallback(url), { kind: 'not-auth-callback' });
  }

  assert.deepEqual(
    parseNativeAuthCallback(`${NATIVE_AUTH_REDIRECT_URL}?code=abcdefgh&code=ijklmnop`),
    { kind: 'error', code: 'invalid-callback' },
  );
  assert.deepEqual(
    parseNativeAuthCallback(`${NATIVE_AUTH_REDIRECT_URL}?code=abcdefgh&sb_flow_id=bad`),
    { kind: 'error', code: 'invalid-callback' },
  );
});

test('return target is validated, expires and is consumed once', () => {
  const storage = createStorage();
  const target = {
    name: 'community',
    tab: 'groups',
    groupId: '9717fef5-e2e8-4a5d-a37f-f630b495196f',
    shareSetId: '21d58855-bda0-47bb-8a53-cfe5aa45c1ad',
    shareToken: 'share_token-123',
  };

  assert.equal(rememberNativeAuthReturnTarget(target, storage, 1_000), true);
  assert.deepEqual(consumeNativeAuthReturnTarget(storage, 1_001), target);
  assert.equal(consumeNativeAuthReturnTarget(storage, 1_002), null);

  assert.equal(rememberNativeAuthReturnTarget({ name: 'sync' }, storage, 1_500), true);
  assert.deepEqual(consumeNativeAuthReturnTarget(storage, 1_501), { name: 'sync' });

  assert.equal(rememberNativeAuthReturnTarget(target, storage, 2_000), true);
  assert.equal(consumeNativeAuthReturnTarget(storage, 2_000 + 30 * 60 * 1_000), null);
  assert.equal(
    rememberNativeAuthReturnTarget({ ...target, shareToken: 'unsafe/token' }, storage, 3_000),
    false,
  );
});

test('PKCE callback exchanges the code and emits only a safe navigation result', async () => {
  beginNativeAuthAttempt({ name: 'settings' });
  const calls = [];
  const events = [];
  const unsubscribe = onNativeAuthResult((event) => events.push(event));
  const client = {
    auth: {
      exchangeCodeForSession: async (code, options) => {
        calls.push({ code, options });
        return {
          data: {
            session: { access_token: 'secret-access-token' },
            user: { id: 'user-123', is_anonymous: false },
          },
          error: null,
        };
      },
    },
  };

  try {
    assert.equal(
      await handleNativeAuthUrl(
        client,
        `${NATIVE_AUTH_REDIRECT_URL}?code=one-time-code-123&sb_flow_id=0123456789abcdef`,
      ),
      true,
    );
  } finally {
    unsubscribe();
  }

  assert.deepEqual(calls, [{ code: 'one-time-code-123', options: { flowId: '0123456789abcdef' } }]);
  assert.deepEqual(events, [{
    type: 'signed-in',
    message: 'ログインしました。',
    returnTarget: { name: 'settings' },
    userId: 'user-123',
  }]);
  assert.doesNotMatch(JSON.stringify(events), /secret-access-token|one-time-code-123/);
});

test('provider errors are mapped without exposing callback details', async () => {
  beginNativeAuthAttempt();
  const events = [];
  const unsubscribe = onNativeAuthResult((event) => events.push(event));
  try {
    assert.equal(
      await handleNativeAuthUrl(
        { auth: { exchangeCodeForSession: async () => assert.fail('must not exchange an error callback') } },
        `${NATIVE_AUTH_REDIRECT_URL}#error=access_denied&error_code=otp_expired&error_description=do-not-display-this-secret`,
      ),
      true,
    );
  } finally {
    unsubscribe();
  }

  assert.equal(events[0]?.type, 'error');
  assert.equal(events[0]?.code, 'expired-link');
  assert.doesNotMatch(JSON.stringify(events), /do-not-display-this-secret|access_denied/);
});

test('native projects and cloud client are wired without changing web auth behavior', async () => {
  const [pkg, androidManifest, androidStrings, infoPlist, nativeAuthSource, cloudService, app, community, settings] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/res/values/strings.xml', import.meta.url), 'utf8'),
    readFile(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/nativeAuth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8'),
  ]);

  assert.equal(JSON.parse(pkg).dependencies['@capacitor/app'], '8.1.1');
  assert.match(androidManifest, /android\.intent\.action\.VIEW/);
  assert.match(androidManifest, /android:scheme="@string\/custom_url_scheme"/);
  assert.match(androidManifest, /android:host="login-callback"/);
  assert.match(androidStrings, /io\.github\.manatocookietwitterlang\.quizmake\.auth/);
  assert.match(infoPlist, /CFBundleURLSchemes[\s\S]*?io\.github\.manatocookietwitterlang\.quizmake\.auth/);
  assert.match(nativeAuthSource, /CapacitorApp\.addListener\('appUrlOpen'/);
  assert.match(nativeAuthSource, /CapacitorApp\.getLaunchUrl\(\)/);
  assert.match(nativeAuthSource, /exchangeCodeForSession/);
  assert.doesNotMatch(nativeAuthSource, /console\.(?:log|debug|info|warn|error)/);

  assert.match(cloudService, /detectSessionInUrl:\s*!nativeAuthPlatform/);
  assert.match(cloudService, /flowType:\s*'pkce'/);
  assert.match(cloudService, /appendPkceFlowIdToRedirects:\s*true/);
  assert.match(cloudService, /verifiedCloudAccess\(cloudClient\.auth,/);
  assert.doesNotMatch(cloudService, /signInAnonymously/);
  assert.match(app, /onNativeAuthResult\([\s\S]*?initializeCloudNativeAuth\(\)/);
  assert.match(app, /event\.returnTarget\s*\?\?\s*\{\s*name:\s*'settings'\s*\}/);
  assert.match(community, /sendMagicLink\(email,\s*\{[\s\S]*?name:\s*'community'/);
  assert.match(settings, /sendMagicLink\(email,\s*\{\s*name:\s*'settings'\s*\}\)/);
});
