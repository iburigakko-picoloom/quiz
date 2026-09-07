import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_SOUND_KEY, getAnswerFeedback, isAnswerSoundEnabled, setAnswerSoundEnabled, playAnswerFeedback, prepareAnswerAudio } from '../src/utils/answerFeedback.ts';

test('relearned depends on the previous answer, not a level or current result', () => {
  for (const previous of [undefined, null, true]) assert.equal(getAnswerFeedback(previous, true), 'correct');
  assert.equal(getAnswerFeedback(false, true), 'relearned');
  for (const previous of [undefined, null, true, false]) assert.equal(getAnswerFeedback(previous, false), 'wrong');
});

test('audio is unlocked by the gesture and closed contexts are recreated', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const contexts = [];
  class FakeAudioContext {
    state = 'suspended';
    sampleRate = 44100;
    destination = {};
    resumes = 0;
    starts = 0;
    constructor() { contexts.push(this); }
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, disconnect() {}, start: () => this.starts++ }; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  try {
    prepareAnswerAudio();
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].resumes, 1);
    assert.equal(contexts[0].starts, 1);
    prepareAnswerAudio();
    assert.equal(contexts[0].resumes, 1, 'running audio does not need another unlock');
    contexts[0].state = 'interrupted';
    prepareAnswerAudio();
    assert.equal(contexts[0].resumes, 2);
    contexts[0].state = 'closed';
    prepareAnswerAudio();
    assert.equal(contexts.length, 2);
    contexts[1].state = 'closed';
    await Promise.resolve();
  } finally {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete globalThis.AudioContext;
  }
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
