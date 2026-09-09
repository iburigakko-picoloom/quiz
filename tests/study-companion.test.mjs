import test from 'node:test';
import assert from 'node:assert/strict';
import { isStudyCompanionEnabled, setStudyCompanionEnabled, companionPraise, companionGreeting } from '../src/utils/studyCompanion.ts';
test('companion preference persists and can be turned off', () => {
  const saved = ['localStorage', 'window'].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  let value = null; let events = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => value, setItem: (_, next) => { value = next; } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: () => events++ } });
  try {
    assert.equal(isStudyCompanionEnabled(), true);
    setStudyCompanionEnabled(false); assert.equal(isStudyCompanionEnabled(), false);
    setStudyCompanionEnabled(true); assert.equal(isStudyCompanionEnabled(), true);
    assert.equal(events, 2);
  } finally { ['localStorage', 'window'].forEach((key, index) => { if (saved[index]) Object.defineProperty(globalThis, key, saved[index]); else delete globalThis[key]; }); }
});
test('praise is encouraging without claiming an incorrect perfect score', () => {
  assert.match(companionPraise(10, 10), /全問正解/);
  assert.doesNotMatch(companionPraise(10, 0), /全問正解/);
  assert.doesNotMatch(companionPraise(0, 0), /全問正解|最後まで/);
});
test('messages vary while keeping praise appropriate to the result', () => {
  const greetings = new Set();
  const praise = new Set();
  for (let i = 0; i < 100; i++) {
    const variant = i / 100;
    greetings.add(companionGreeting(variant));
    praise.add(companionPraise(10, 5, variant));
    assert.match(companionPraise(10, 10, variant), /全問正解/);
    assert.doesNotMatch(companionPraise(10, 5, variant), /全問正解/);
    assert.doesNotMatch(companionPraise(0, 0, variant), /全問正解|最後まで/);
  }
  assert.equal(greetings.size, 6);
  assert.equal(praise.size, 5);
});
