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

test('all answer outcomes play louder audio, while the off preference stays silent', () => {
  const keys = ['AudioContext', 'window', 'localStorage'];
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const oscillators = [];
  const gains = [];
  let enabled = true;
  let audio;
  class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() { audio = this; }
    createGain() {
      const node = { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
      gains.push(node);
      return node;
    }
    createOscillator() {
      const node = { frequency: { value: 0 }, stoppedAt: 0, connect() {}, disconnect() {}, start() {}, stop(time) { this.stoppedAt = time; } };
      oscillators.push(node);
      return node;
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout() {} } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => enabled ? 'on' : 'off' } });
  try {
    for (const [kind, frequencies, duration] of [['correct', [784], 0.75], ['relearned', [660, 880], 1], ['wrong', [330, 220], 0.6]]) {
      oscillators.length = 0;
      gains.length = 0;
      playAnswerFeedback(kind);
      assert.deepEqual(oscillators.map((node) => node.frequency.value), frequencies);
      assert.ok(oscillators.every((node) => node.stoppedAt === duration));
      assert.equal(gains[0].gain.value, 1);
    }
    enabled = false;
    oscillators.length = 0;
    for (const kind of ['correct', 'relearned', 'wrong']) playAnswerFeedback(kind);
    assert.equal(oscillators.length, 0);
  } finally {
    if (audio) audio.state = 'closed';
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globalThis, key, originals[index]);
      else delete globalThis[key];
    });
  }
});
