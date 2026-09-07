import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const layoutSource = readSource('../src/components/Layout.tsx');
const headerSource = readSource('../src/components/Header.tsx');
const detailSource = readSource('../src/screens/ProblemSetDetailScreen.tsx');
const appSource = readSource('../src/App.tsx');
const globalCss = readSource('../src/index.css');
const syncCss = readSource('../src/screens/SyncScreen.css');
const detailCss = readSource('../src/screens/ProblemSetDetailScreen.css');
const quizRunnerSource = readSource('../src/screens/QuizRunner.tsx');

test('shared layout and loading state use the light application palette', () => {
  assert.doesNotMatch(layoutSource, /bg-\[#050505\]|text-white/);
  assert.match(layoutSource, /bg-\[#FFFFFF\]/);
  assert.match(layoutSource, /text-\[#172033\]/);
  assert.doesNotMatch(appSource, /background:\s*'#000'/);
  assert.match(appSource, /background:\s*'#f1f7fa'/);
});

test('set-scoped review UI and its shared header use restrained light surfaces', () => {
  assert.doesNotMatch(headerSource, /bg-\[#202020\]|bg-\[#2B2B2B\]|text-white/);
  assert.match(headerSource, /bg-white/);
  assert.doesNotMatch(headerSource, /bg-gradient|skew/);
  assert.match(detailSource, /Level 3到達率/);
  assert.match(detailSource, /登録順で解く/);
  assert.match(detailSource, /ランダムで解く/);
  assert.doesNotMatch(detailSource, /この問題セットを復習/);
  assert.match(detailSource, /progress.reviewLevel === 3 \|\| progress.isGraduated/);
  assert.match(detailSource, /questions.length \? Math.round\(reachedLevelThree \/ questions.length \* 100\) : 0/);
});

test('quiz exit confirmation uses the light surface palette', () => {
  const exitDialogCss = globalCss.slice(
    globalCss.indexOf('.quiz-exit-confirm {'),
    globalCss.indexOf('.quiz-runner__answer-actions--spacer'),
  );

  assert.notEqual(exitDialogCss.length, 0);
  assert.doesNotMatch(exitDialogCss, /background:\s*#202020|background:\s*#2b2b2b/);
  assert.match(exitDialogCss, /background:\s*#ffffff/);
  assert.match(exitDialogCss, /color:\s*#173042/);
});

test('quiz runner uses the shared light palette while preserving answer states', () => {
  assert.doesNotMatch(quizRunnerSource, /#E9E5D8|#B89C79|#F7F7F5|#5FA9DD/);
  assert.match(globalCss, /\.quiz-runner \{[^}]*background:\s*var\(--ui-page/);
  assert.match(globalCss, /\.quiz-runner__question-panel \{[^}]*background:\s*var\(--ui-surface/);
  assert.match(globalCss, /\.quiz-choice--correct \{[^}]*background:\s*#e7f6eb/);
  assert.match(globalCss, /\.quiz-choice--wrong \{[^}]*background:\s*#fff0f0/);
  assert.match(globalCss, /\.answer-sheet__action--ambiguous \{[^}]*background:\s*#fff1dc/);
  assert.match(globalCss, /\.answer-sheet__markdown-table-wrap \{[^}]*overflow-x:\s*auto/);
});

test('problem-set detail restores visible horizontally scrollable conditions before starting', () => {
  const startIndex = detailSource.indexOf('quiz-detail__start-panel');
  const filterIndex = detailSource.indexOf('quiz-detail__filters"');
  const actionIndex = detailSource.indexOf('aria-label="学習方法"');
  const summaryIndex = detailSource.indexOf('quiz-detail__summary');
  const listIndex = detailSource.indexOf('quiz-detail__entry-grid');

  assert.ok(summaryIndex >= 0 && summaryIndex < startIndex && actionIndex < listIndex);
  assert.ok(filterIndex >= 0 && filterIndex < actionIndex);
  assert.match(detailSource, /aria-label="学習方法"[\s\S]*?登録順で解く[\s\S]*?ランダムで解く/);
  assert.match(detailSource, /aria-label="問題セットの操作"[\s\S]*?onClick=\{onShare\}/);
  assert.doesNotMatch(detailSource, /<details className="quiz-detail__filters">/);
  assert.match(detailCss, /\.quiz-detail \.quiz-detail__segments \{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/);
  assert.match(detailCss, /\.quiz-detail \.quiz-detail__segments::-webkit-scrollbar \{[^}]*display:\s*none/);
  assert.match(detailCss, /\.quiz-detail button\.quiz-detail__segment-item \{[^}]*flex:\s*0 0 auto/);
  assert.doesNotMatch(detailSource, /quiz-detail__start-action--review/);
});

test('sync settings uses the same restrained light palette as other settings screens', () => {
  assert.match(syncCss, /\.sync-screen \{[\s\S]*?background:\s*#f1f5f9/);
  assert.match(syncCss, /\.sync-screen__header \{[\s\S]*?background:\s*rgba\(255, 255, 255/);
  assert.doesNotMatch(syncCss, /background:\s*#000000|background:\s*#202020|color:\s*#ffffff;\s*overflow/);
});
