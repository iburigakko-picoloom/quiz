import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {after,test} from 'node:test';
const hooks = registerHooks({resolve(specifier, context, next) {
  return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
    && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
}});
after(() => hooks.deregister());
const {safeSyncFailureMessage} = await import('../src/utils/syncFailureDiagnostic.ts');
test('retained pull failure explains a known cause after the older status error was cleared',()=>{
  const retainedCloudGraph='クラウドの参照関係を確認できません。端末と受信原本を保持しています。';
  assert.equal(safeSyncFailureMessage(retainedCloudGraph),retainedCloudGraph);
  for(const message of ['差分読込のCursorが不正です。','差分読込の変更履歴が連続していません。','保存レコードの一部が失われています。','questions[23] が存在しない問題セットを参照しています。','questions[1].choices は4個または5個の文字列である必要があります。'])assert.equal(safeSyncFailureMessage(message),message);
  const status=readFileSync(new URL('../src/components/SyncStatus.tsx',import.meta.url),'utf8');assert.match(status,/safeSyncFailureMessage\(attempt.lastFailure.message\)/);
});
test('diagnostic message does not echo IDs, tokens, URLs or arbitrary problem content',()=>{
  assert.equal(safeSyncFailureMessage('questions に重複ID「private-question-id」があります。'),'questions に重複したIDがあります。');
  for(const value of ['Authorization: Bearer private-token','https://private.test/?key=secret','User answer private data','差分エラー private-answer','questions[1] private-answer'])assert.doesNotMatch(safeSyncFailureMessage(value),/private|secret|Bearer/);
});

test('server timeout and cloud quota show distinct causes without implying local storage is full',async()=>{
  const {syncFailureReason}=await import('../src/utils/syncStatusReason.ts');
  assert.equal(safeSyncFailureMessage('クラウドの保存処理が時間切れになりました。'),'クラウドの保存処理が時間切れになりました。');
  assert.equal(syncFailureReason({code:'server_timeout',step:'receipt',message:'private SQL'}),'クラウドの保存処理が時間切れになりました。再試行します。');
  assert.equal(syncFailureReason({code:'quota',step:'push',message:'private SQL'}),'クラウドの保存容量が上限に達しました。');
});
test('basic connection success never claims the record protocol succeeded',()=>{
  const screen=readFileSync(new URL('../src/screens/SyncScreen.tsx',import.meta.url),'utf8');assert.doesNotMatch(screen,/接続診断が完了しました。すべてOKです。/);assert.match(screen,/基本接続の診断が完了しました。差分同期の成否は前回の失敗欄/);
});
