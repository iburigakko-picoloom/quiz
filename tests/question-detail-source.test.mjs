import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveQuestionDetailedExplanation, resolveQuestionDetailedImageIds } from '../src/utils/questionView.ts';

const sessionQuestion = {
  id: 'question-1',
  setId: 'set-1',
  question: 'Question',
  choices: ['A', 'B'],
  answerIndex: 0,
  answerText: 'A',
  explanation: 'Explanation',
  detailedExplanation: 'old explanation',
  sourcePage: '',
  category: '',
  difficulty: 'basic',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('uses the latest persisted detailed explanation instead of the frozen session copy', () => {
  const persistedQuestion = {
    ...sessionQuestion,
    detailedExplanation: 'new explanation',
  };

  assert.equal(
    resolveQuestionDetailedExplanation([persistedQuestion], sessionQuestion),
    'new explanation',
  );
});

test('treats a persisted deletion as authoritative', () => {
  const persistedQuestion = {
    ...sessionQuestion,
    detailedExplanation: '',
  };

  assert.equal(
    resolveQuestionDetailedExplanation([persistedQuestion], sessionQuestion),
    '',
  );
});

test('falls back to the session copy when the question no longer exists in AppData', () => {
  assert.equal(
    resolveQuestionDetailedExplanation([], sessionQuestion),
    'old explanation',
  );
});

test('shows images added or removed during a frozen quiz session', () => {
  const original = { ...sessionQuestion, detailedAnswer: { body: '', imageIds: ['old'], updatedAt: sessionQuestion.updatedAt } };
  const updated = { ...original, detailedAnswer: { ...original.detailedAnswer, imageIds: ['new'] } };
  assert.deepEqual(resolveQuestionDetailedImageIds([updated], original), ['new']);
  assert.deepEqual(resolveQuestionDetailedImageIds([], original), ['old']);
  assert.deepEqual(resolveQuestionDetailedImageIds([sessionQuestion], original), []);
});
