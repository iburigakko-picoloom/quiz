import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('native store projects use the stable QuizMake application id', () => {
  const capacitor = readSource('../capacitor.config.ts');
  const android = readSource('../android/app/build.gradle');
  const ios = readSource('../ios/App/App.xcodeproj/project.pbxproj');
  const appId = 'io.github.manatocookietwitterlang.quizmake';
  assert.match(capacitor, new RegExp(appId.replaceAll('.', '\\.')));
  assert.match(android, new RegExp(appId.replaceAll('.', '\\.')));
  assert.match(ios, new RegExp(appId.replaceAll('.', '\\.')));
});

test('Windows sync leaves iOS Swift package paths usable on macOS', () => {
  const swiftPackage = readSource('../ios/App/CapApp-SPM/Package.swift');
  assert.doesNotMatch(swiftPackage, /\\\\/);
  assert.match(swiftPackage, /\.\.\/\.\.\/\.\.\/node_modules\/@capacitor\/clipboard/);
});

test('native builds use relative assets and skip the web service worker', () => {
  const vite = readSource('../vite.config.ts');
  const serviceWorker = readSource('../src/registerServiceWorker.ts');
  assert.match(vite, /mode === "native" \? "\.\/" : "\/quiz\/"/);
  assert.match(serviceWorker, /Capacitor\.isNativePlatform\(\)/);
});

test('privacy policy, support page, deletion path and iOS privacy manifest exist', () => {
  const settings = readSource('../src/screens/SettingsScreen.tsx');
  const sync = readSource('../src/screens/SyncScreen.tsx');
  const migration = readSource('../supabase/migrations/20260805_add_quiz_sync_delete_rpc.sql');
  const privacyManifest = readSource('../ios/App/App/PrivacyInfo.xcprivacy');
  assert.match(settings, /プライバシーポリシー/);
  assert.match(sync, /クラウドデータを削除/);
  assert.match(migration, /quiz_sync_delete/);
  assert.match(privacyManifest, /NSPrivacyAccessedAPICategoryFileTimestamp/);
  assert.match(privacyManifest, /C617\.1/);
  assert.equal(existsSync(new URL('../public/privacy.html', import.meta.url)), true);
  assert.equal(existsSync(new URL('../public/support.html', import.meta.url)), true);
});

test('root render failures show recovery actions instead of a blank screen', () => {
  const main = readSource('../src/main.tsx');
  const boundary = readSource('../src/components/AppErrorBoundary.tsx');
  assert.match(main, /<AppErrorBoundary>/);
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /再読み込み/);
  assert.match(boundary, /端末データを書き出す/);
  assert.match(boundary, /exportQuizMakeRecoveryData/);
  assert.match(boundary, /support\.html/);
});
