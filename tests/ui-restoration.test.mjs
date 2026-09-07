import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const quizSource = readSource('../src/screens/QuizRunner.tsx');
const globalCss = readSource('../src/index.css');
const navCss = readSource('../src/components/PrimaryBottomNav.css');
const iconSource = readSource('../src/components/UiIcons.tsx');
const createCss = readSource('../src/screens/CreateProblemSetScreen.css');
const communityCss = readSource('../src/screens/CommunityScreen.css');

test('the historical answer sheet and screen transitions remain intact', () => {
  assert.match(globalCss, /\.quiz-screen-transition--forward/);
  assert.match(globalCss, /@keyframes quizScreenForwardIn/);
  assert.match(globalCss, /\.answer-sheet--expanded/);
  assert.match(globalCss, /height 280ms cubic-bezier/);
  assert.match(globalCss, /\.answer-sheet__content-rail--detail/);
  assert.match(globalCss, /\.answer-sheet__fixed \{[^}]*touch-action:\s*none/);
  assert.match(quizSource, /const snapByDrag = \(dragOffset: number, velocityY: number\)/);
  assert.match(quizSource, /onPointerDown: handlePointerDown[\s\S]*?onPointerMove: handlePointerMove[\s\S]*?onPointerUp: handlePointerUp/);
  assert.match(quizSource, /className="answer-sheet__fixed" \{\.\.\.dragProps\}/);
  assert.match(quizSource, /onPointerDownCapture: handleDetailPointerDown/);
  assert.match(quizSource, /onPointerMoveCapture: handleDetailPointerMove/);
  assert.match(quizSource, /panelPage === 'answer' && deltaX < 0/);
  assert.match(quizSource, /panelPage === 'detail' && deltaX > 0/);
  assert.match(quizSource, /remarkPlugins=\{\[remarkGfm\]\}/);
});

test('learning feedback animates without removing reduced-motion support', () => {
  assert.match(quizSource, /key=\{currentQuestion\.id\}[^>]+quiz-runner__question-stage/);
  assert.match(globalCss, /@keyframes quizQuestionEnter/);
  assert.match(globalCss, /@keyframes quizChoiceCorrect/);
  assert.match(globalCss, /@keyframes quizChoiceWrong/);
  assert.match(globalCss, /@keyframes answerSheetReveal/);
  assert.match(globalCss, /@keyframes answerResultReveal/);
  assert.match(globalCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.quiz-runner__question-stage/);
  assert.match(navCss, /\.primary-bottom-nav__item:active/);
});

test('sheet swipes follow the pointer across the sheet without stealing text editing', () => {
  assert.match(quizSource, /onPointerMoveCapture: handleDetailPointerMove/);
  assert.match(quizSource, /rail\.style\.transition = 'none'/);
  assert.match(quizSource, /rail\.style\.transform = `translateX/);
  assert.match(quizSource, /if \(draggingRef\.current\) resetDrag\(\)/);
  assert.match(quizSource, /onPointerCancelCapture:/);
  assert.match(quizSource, /suppressSwipeClickRef\.current && event\.detail !== 0/);
  assert.match(quizSource, /!target\.closest\('\.answer-sheet__drag-area'\)/);
  const css = readSource('../src/final-reference.css');
  assert.match(css, /\.answer-sheet__drag-capture \{[^}]*width: 100%/);
  assert.match(css, /\.answer-sheet__content-rail--detail \{ transform: translateX\(-100%\)/);
});

test('detailed answers open from the standard sheet and an empty answer is editable', () => {
  const open = quizSource.slice(quizSource.indexOf('const openDetailPage'), quizSource.indexOf('const handleClipboardRead'));
  assert.match(open, /if \(state !== 'expanded'\) onExpand\(\)/);
  assert.doesNotMatch(open, /if \(!start \|\| state !== 'expanded'\)/);
  assert.match(open, /setPointerCapture/);
  assert.match(quizSource, /const detailEditingDisabled = readOnly \|\| answerSaveState !== 'saved'/);
  assert.match(quizSource, /\{\.\.\.detailSwipeProps\}/);
  assert.doesNotMatch(quizSource, /className="answer-sheet__detail-preview"|className="answer-sheet__detail-helper"/);
});

test('management icons use soft fills and one shared blue currentColor system', () => {
  for (const icon of ['FolderOutlineIcon', 'DocumentOutlineIcon', 'BookmarkIcon', 'TagIcon', 'ProgressIcon', 'ProfileIcon']) {
    assert.match(iconSource, new RegExp(`export function ${icon}`));
  }
  assert.match(iconSource, /fill="currentColor"/);
  assert.doesNotMatch(iconSource, /#(?:[a-f\d]{3}|[a-f\d]{6})/i);
  for (const source of [globalCss, createCss, communityCss]) {
    assert.doesNotMatch(source, /#12bfc0|#149da1|#168e92|#39b9b3|rgba\(18,\s*191,\s*192/i);
  }
});
