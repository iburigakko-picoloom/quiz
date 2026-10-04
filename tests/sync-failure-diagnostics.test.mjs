import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {safeSyncFailureMessage} from '../src/utils/syncFailureDiagnostic.ts';
test('retained pull failure explains a known cause after the older status error was cleared',()=>{
  for(const message of ['差分読込のCursorが不正です。','差分読込の変更履歴が連続していません。','保存レコードの一部が失われています。','questions[23] が存在しない問題セットを参照しています。','questions[1].choices は4個または5個の文字列である必要があります。'])assert.equal(safeSyncFailureMessage(message),message);
  const status=readFileSync(new URL('../src/components/SyncStatus.tsx',import.meta.url),'utf8');assert.match(status,/safeSyncFailureMessage\(attempt.lastFailure.message\)/);
});
test('diagnostic message does not echo IDs, tokens, URLs or arbitrary problem content',()=>{
  assert.equal(safeSyncFailureMessage('questions に重複ID「private-question-id」があります。'),'questions に重複したIDがあります。');
  for(const value of ['Authorization: Bearer private-token','https://private.test/?key=secret','User answer private data','差分エラー private-answer','questions[1] private-answer'])assert.doesNotMatch(safeSyncFailureMessage(value),/private|secret|Bearer/);
});
test('basic connection success never claims the record protocol succeeded',()=>{
  const screen=readFileSync(new URL('../src/screens/SyncScreen.tsx',import.meta.url),'utf8');assert.doesNotMatch(screen,/接続診断が完了しました。すべてOKです。/);assert.match(screen,/基本接続の診断が完了しました。差分同期の成否は前回の失敗欄/);
});
