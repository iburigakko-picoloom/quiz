import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_SOUND_KEY, getAnswerFeedback, isAnswerSoundEnabled, setAnswerSoundEnabled, playAnswerFeedback } from '../src/utils/answerFeedback.ts';

test('relearned depends on the previous answer, not a level or current result', () => {
  for (const previous of [undefined, null, true]) assert.equal(getAnswerFeedback(previous, true), 'correct');
  assert.equal(getAnswerFeedback(false, true), 'relearned');
  for (const previous of [undefined, null, true, false]) assert.equal(getAnswerFeedback(previous, false), 'wrong');
});

test('answer sound defaults on and persists a per-device preference', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)}});
  try {
    assert.equal(isAnswerSoundEnabled(), true);
    setAnswerSoundEnabled(false);
    assert.equal(values.get(ANSWER_SOUND_KEY), 'off');
    assert.equal(isAnswerSoundEnabled(), false);
    assert.doesNotThrow(() => playAnswerFeedback('correct'));
    setAnswerSoundEnabled(true);
    assert.equal(isAnswerSoundEnabled(), true);
    assert.doesNotThrow(() => playAnswerFeedback('wrong'));
    assert.doesNotThrow(() => playAnswerFeedback('correct'), 'unavailable audio must not interrupt learning');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
