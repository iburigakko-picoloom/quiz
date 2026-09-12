import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const quizSource = readSource('../src/screens/QuizRunner.tsx');

test('visible question numbers use the full set order, not the current session position',()=>{
  assert.match(quizSource,/QUESTION \{registeredQuestionNumber\}/);
  assert.doesNotMatch(quizSource,/QUESTION \{currentIndex \+ 1\}/);
  assert.match(quizSource,/data\.questions\.filter\(\(question\) => question\.setId === currentQuestion\.setId\)/);
  assert.match(quizSource,/sameSetQuestions\.findIndex\(\(question\) => question\.id === currentQuestion\.id\)/);
  assert.match(quizSource,/<QuizHeader title=\{title\} current=\{currentIndex \+ 1\} total=\{questions.length\}/);
});

test('answer and detail page navigation exposes opposite directions at the top',()=>{
  const answer=quizSource.slice(quizSource.indexOf('const answerPage ='),quizSource.indexOf('const detailPage ='));
  assert.ok(answer.indexOf('answer-sheet__page-navigation')<answer.indexOf('answer-sheet__answer-box'));
  assert.match(answer,/aria-label="右側の解説・メモへ"/);
  assert.match(quizSource,/aria-label="左側の解答に戻る"/);
  assert.equal((quizSource.match(/ref=\{detailOpenRef\}/g)||[]).length,1);
  const css=readSource('../src/final-reference.css');
  assert.match(css,/\.answer-sheet__page-navigation \{ position: sticky; top: 0/);
  assert.match(css,/justify-content: space-between/);
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
