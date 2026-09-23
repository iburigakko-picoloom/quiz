import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { getReviewDueAt, isReviewTarget } from '../src/utils/reviewTargets.ts';

const extensionHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const isExtensionlessRelativeImport = /^\.\.?\//u.test(specifier)
      && !/\.[cm]?[jt]sx?$/u.test(specifier)
      && context.parentURL?.endsWith('.ts');
    return nextResolve(isExtensionlessRelativeImport ? `${specifier}.ts` : specifier, context);
  },
});
const { recordAnswer, toggleAmbiguous, toggleStudyCompleted } = await import('../src/utils/quiz.ts');
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
extensionHook.deregister();

const initialProgress = {
  questionId: 'question-1',
  answeredCount: 0,
  correctCount: 0,
  wrongCount: 0,
  lastSelectedIndex: null,
  lastAnswerCorrect: null,
  lastAnsweredAt: null,
  isReview: false,
  isAmbiguous: false,
  reviewLevel: null,
  isGraduated: false,
};

test('unanswered questions are not counted as review targets', () => {
  assert.equal(isReviewTarget(initialProgress), false);
});

test('wrong-answer and ambiguous targets wait a day before review', () => {
  const now = new Date(2026, 8, 23, 12);
  const yesterday = new Date(2026, 8, 22, 23).toISOString();
  assert.equal(isReviewTarget({
    ...initialProgress,
    answeredCount: 1,
    wrongCount: 1,
    lastAnsweredAt: yesterday,
    isReview: true,
    reviewLevel: 1,
  }, now), true);

  assert.equal(isReviewTarget({
    ...initialProgress,
    answeredCount: 1,
    lastAnsweredAt: yesterday,
    isReview: true,
    isAmbiguous: true,
  }, now), true);
  assert.equal(isReviewTarget({ ...initialProgress, answeredCount: 1, isReview: true, lastAnsweredAt: new Date(2026, 8, 23, 1).toISOString() }, now), false);
  assert.equal(isReviewTarget({ ...initialProgress, isReview: true, isAmbiguous: true }, now), false);
});

test('review intervals follow local calendar days for levels 1, 2 and 3', () => {
  const lastAnsweredAt = new Date(2026, 8, 20, 23).toISOString();
  for (const [reviewLevel, days] of [[1, 1], [2, 3], [3, 7]]) {
    const progress = { ...initialProgress, answeredCount: 1, isReview: true, lastAnswerCorrect: true, lastAnsweredAt, reviewLevel };
    assert.equal(getReviewDueAt(progress), new Date(2026, 8, 20 + days).getTime());
    assert.equal(isReviewTarget(progress, new Date(2026, 8, 20 + days - 1, 23)), false);
    assert.equal(isReviewTarget(progress, new Date(2026, 8, 20 + days)), true);
  }
  const wrong = { ...initialProgress, answeredCount: 2, isReview: true, lastAnswerCorrect: false, lastAnsweredAt, reviewLevel: 3 };
  assert.equal(getReviewDueAt(wrong), new Date(2026, 8, 21).getTime());
});

test('graduated questions are excluded from review', () => {
  assert.equal(isReviewTarget({
    ...initialProgress,
    answeredCount: 4,
    correctCount: 4,
    isReview: false,
    reviewLevel: 3,
    isGraduated: true,
  }), false);
});

const timestamp = '2026-08-15T00:00:00.000Z';
const multipleAnswerQuestion = {
  id: 'question-multiple',
  setId: 'set-1',
  question: 'Select both correct choices.',
  choices: ['first', 'second', 'third', 'fourth'],
  answerIndex: 0,
  answerIndexes: [0, 2],
  answerText: 'first, third',
  explanation: '',
  sourcePage: '',
  category: '',
  difficulty: 'standard',
  createdAt: timestamp,
  updatedAt: timestamp,
};

function createAnswerTestData() {
  return {
    version: 1,
    folders: [{ id: 'folder-1', name: 'Folder', createdAt: timestamp, updatedAt: timestamp }],
    problemSets: [{ id: 'set-1', folderId: 'folder-1', title: 'Set', source: '', createdAt: timestamp, updatedAt: timestamp }],
    questions: [multipleAnswerQuestion],
    progress: [],
    answerLogs: [],
  };
}

test('recordAnswer applies the same mutation id only once', () => {
  const first = recordAnswer(
    createAnswerTestData(),
    multipleAnswerQuestion,
    [2, 0],
    false,
    'answer-mutation-1',
  );
  const replay = recordAnswer(
    first.data,
    multipleAnswerQuestion,
    [1],
    false,
    'answer-mutation-1',
  );

  assert.equal(first.isCorrect, true);
  assert.strictEqual(replay.data, first.data);
  assert.equal(replay.isCorrect, true);
  assert.equal(replay.data.answerLogs.length, 1);
  assert.equal(replay.data.answerLogs[0].id, 'answer-mutation-1');
  assert.deepEqual(replay.progress, first.progress);
  assert.deepEqual(replay.progress, {
    ...initialProgress,
    questionId: multipleAnswerQuestion.id,
    answeredCount: 1,
    correctCount: 1,
    lastSelectedIndex: 2,
    lastAnswerCorrect: true,
    lastAnsweredAt: first.progress.lastAnsweredAt,
    isReview: true,
    reviewLevel: 1,
  });
});

test('manual study completion survives normalization and later answers until explicitly undone', () => {
  const first = recordAnswer(createAnswerTestData(), multipleAnswerQuestion, [0, 2], false);
  const completed = toggleStudyCompleted(first.data, multipleAnswerQuestion.id);
  assert.equal(completed.progress[0].isStudyCompleted, true);
  assert.equal(isReviewTarget(completed.progress[0], new Date(2030, 0, 1)), false);
  const restored = normalizeAppData(JSON.parse(JSON.stringify(completed)));
  assert.equal(restored.ok, true);
  assert.equal(restored.data.progress[0].isStudyCompleted, true);
  const answeredAgain = recordAnswer(restored.data, multipleAnswerQuestion, [0, 2], false);
  assert.equal(answeredAgain.progress.isStudyCompleted, true);
  assert.equal(answeredAgain.addedToReview, false);
  const resumed = toggleStudyCompleted(answeredAgain.data, multipleAnswerQuestion.id);
  assert.equal(resumed.progress[0].isStudyCompleted, false);
  assert.equal(isReviewTarget(resumed.progress[0], new Date(2030, 0, 1)), true);
  assert.equal(toggleAmbiguous(completed, multipleAnswerQuestion.id).progress[0].isStudyCompleted, false);
});

test('correct answers only advance levels after the scheduled review day', () => {
  const first = recordAnswer(createAnswerTestData(), multipleAnswerQuestion, [0, 2], false);
  assert.equal(first.progress.reviewLevel, 1);
  const early = recordAnswer(first.data, multipleAnswerQuestion, [0, 2], false);
  assert.equal(early.progress.reviewLevel, 1);
  const setOverdue = (data, level) => ({
    ...data,
    progress: [{ ...data.progress[0], reviewLevel: level, lastAnsweredAt: timestamp }],
  });
  const second = recordAnswer(setOverdue(early.data, 1), multipleAnswerQuestion, [0, 2], true);
  assert.equal(second.progress.reviewLevel, 2);
  const third = recordAnswer(setOverdue(second.data, 2), multipleAnswerQuestion, [0, 2], true);
  assert.equal(third.progress.reviewLevel, 3);
  const fourth = recordAnswer(setOverdue(third.data, 3), multipleAnswerQuestion, [0, 2], true);
  assert.equal(fourth.progress.isGraduated, true);
  assert.equal(isReviewTarget(fourth.progress, new Date(2030, 0, 1)), false);
});

test('recordAnswer applies different mutation ids independently', () => {
  const first = recordAnswer(
    createAnswerTestData(),
    multipleAnswerQuestion,
    [0, 2],
    false,
    'answer-mutation-1',
  );
  const second = recordAnswer(
    first.data,
    multipleAnswerQuestion,
    [0],
    false,
    'answer-mutation-2',
  );

  assert.equal(second.isCorrect, false);
  assert.deepEqual(second.data.answerLogs.map((log) => log.id), ['answer-mutation-1', 'answer-mutation-2']);
  assert.equal(second.progress.answeredCount, 2);
  assert.equal(second.progress.correctCount, 1);
  assert.equal(second.progress.wrongCount, 1);
  assert.equal(second.progress.reviewLevel, 1);
});
