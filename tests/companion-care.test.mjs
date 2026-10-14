import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPANION_BALANCE, COMPANION_TRICKS, createCompanionCare, parseCompanionCare, creditCompanionAnswers,
  refreshCompanionDay, applyCompanionCareAction, isCompanionTrickLearned, canTeachCompanionTrick,
  companionReactions, pickCompanionReaction, companionSessionFood } from '../src/utils/companionCare.ts';

const day = '2026-10-14';
const logs = (count, prefix = 'answer') => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, isCorrect: i % 2 === 0 }));
const funded = (food = 60) => creditCompanionAnswers(createCompanionCare(day), logs(food * COMPANION_BALANCE.answersPerFood));

test('correct, incorrect and repeated-question review answers earn every 20 unique saved IDs; remainder survives a new day', () => {
  const first = creditCompanionAnswers(createCompanionCare(day), logs(19));
  assert.equal(first.food, 0); assert.equal(first.answerRemainder, 19);
  const restored = parseCompanionCare(JSON.stringify(refreshCompanionDay(first, '2026-10-15', true)));
  const next = creditCompanionAnswers(restored, [...logs(19), ...logs(2, 'review')]);
  assert.equal(next.food, 1); assert.equal(next.answerRemainder, 1); assert.equal(next.creditedAnswerIds.length, 21);
  assert.equal(creditCompanionAnswers(next, [...logs(19), ...logs(2, 'review')]), next);
  assert.equal(companionSessionFood(next, ['review-0', 'review-0', 'review-1']), 1);
});

test('duplicate history, result reopen, deletion and restoring previously rewarded IDs cannot produce extra food', () => {
  let care = creditCompanionAnswers(createCompanionCare(day), [...logs(40), ...logs(40)]);
  assert.equal(care.food, 2);
  care = applyCompanionCareAction(care, { kind: 'feed' }, day);
  assert.equal(care.food, 1);
  assert.equal(creditCompanionAnswers(care, []), care);
  assert.equal(creditCompanionAnswers(parseCompanionCare(JSON.stringify(care)), logs(40)).food, 1);
  assert.equal(companionSessionFood(care, ['answer-19', 'answer-39']), 2);
  assert.equal(companionSessionFood(care, ['preview-19']), 0);
});

test('batch completion pays all earned food, and stored food never expires', () => {
  let care = creditCompanionAnswers(createCompanionCare(day), logs(105));
  assert.equal(care.food, 5); assert.equal(care.answerRemainder, 5);
  care = refreshCompanionDay(care, '2030-10-14');
  assert.equal(care.food, 5); assert.equal(care.answerRemainder, 5);
});

test('petting always works but only three interactions gain friendship per calendar day', () => {
  let care = createCompanionCare(day);
  for (let i = 0; i < 20; i++) care = applyCompanionCareAction(care, { kind: 'pet' }, day);
  assert.equal(care.friendship, 1.5); assert.equal(care.rewardedPets, 3); assert.equal(care.food, 0);
  care = applyCompanionCareAction(parseCompanionCare(JSON.stringify(care)), { kind: 'pet' }, '2026-10-15');
  assert.equal(care.friendship, 2); assert.equal(care.rewardedPets, 1);
});

test('two days are safe; day three starts gentle decay once, including month/year transitions', () => {
  const care = { ...createCompanionCare('2026-12-30'), friendship: 40, peakFriendship: 40 };
  const two = refreshCompanionDay(care, '2027-01-01'); assert.equal(two.friendship, 40);
  const three = refreshCompanionDay(two, '2027-01-02'); assert.equal(three.friendship, 39);
  assert.equal(refreshCompanionDay(three, '2027-01-02'), three);
  assert.equal(refreshCompanionDay(three, '2027-01-03').friendship, 38);
  const visited = refreshCompanionDay(three, '2027-01-02', true);
  assert.equal(refreshCompanionDay(visited, '2027-01-04').friendship, 39);
  assert.equal(refreshCompanionDay(visited, '2027-01-05').friendship, 38);
  assert.equal(refreshCompanionDay(three, '2026-12-31'), three, 'clock rollback cannot restart decay or pet rewards');
});

test('bond loss reduces spontaneous reactions, keeps learned tricks and never goes below zero', () => {
  const care = { ...funded(), friendship: 60, peakFriendship: 60, tricks: { spin: 5, touch: 8, bow: 10, roll: 12, sleep: 16 } };
  assert.equal(companionReactions(care.friendship).length, 5);
  const absent = refreshCompanionDay(care, '2027-10-14');
  assert.equal(absent.friendship, 0); assert.equal(absent.peakFriendship, 60);
  assert.deepEqual(companionReactions(absent.friendship), ['watch']);
  for (const trick of COMPANION_TRICKS) assert.equal(isCompanionTrickLearned(absent, trick.id), true);
});

test('recovery is faster up to the previous peak and normal beyond it; friendship caps at 100', () => {
  const care = { ...funded(), friendship: 33, peakFriendship: 40 };
  const recovered = applyCompanionCareAction(care, { kind: 'feed' }, day);
  assert.equal(recovered.friendship, 40.5); assert.equal(recovered.peakFriendship, 40.5);
  assert.equal(applyCompanionCareAction(recovered, { kind: 'feed' }, day).friendship, 44.5);
  assert.equal(applyCompanionCareAction({ ...care, friendship: 99, peakFriendship: 100 }, { kind: 'feed' }, day).friendship, 100);
});

test('spontaneous affectionate reactions become less frequent as friendship falls, even while the same tricks remain learned', () => {
  const counts = bond => {
    const result = { watch: 0, happy: 0, approach: 0, cuddle: 0, relax: 0 };
    for (let i = 0; i < 10_000; i++) result[pickCompanionReaction(bond, (i + .5) / 10_000)]++;
    return result;
  };
  const high = counts(100), medium = counts(60), low = counts(38), shy = counts(20), stranger = counts(0);
  assert.ok(high.cuddle > medium.cuddle && medium.cuddle > low.cuddle && low.cuddle > shy.cuddle);
  assert.ok(high.approach > medium.approach && medium.approach > low.approach);
  assert.ok(high.relax > medium.relax && medium.relax > low.relax);
  assert.ok(high.watch < medium.watch && medium.watch < low.watch && low.watch < shy.watch);
  assert.equal(stranger.watch, 10_000);
});

test('paid practice always advances one step and bonds; learned tricks cannot consume food again', () => {
  let care = funded();
  assert.equal(canTeachCompanionTrick(care, 'touch'), false);
  assert.throws(() => applyCompanionCareAction(care, { kind: 'train', trickId: 'touch' }, day), /なかよく/);
  for (let i = 0; i < 5; i++) {
    care = applyCompanionCareAction(care, { kind: 'train', trickId: 'spin' }, day);
    assert.equal(care.tricks.spin, i + 1); assert.equal(care.friendship, (i + 1) * 3);
  }
  assert.equal(isCompanionTrickLearned(care, 'spin'), true);
  assert.equal(canTeachCompanionTrick(care, 'touch'), true);
  assert.throws(() => applyCompanionCareAction(care, { kind: 'train', trickId: 'spin' }, day), /習得済み/);
  assert.equal(care.food, 55);
  assert.throws(() => applyCompanionCareAction(createCompanionCare(day), { kind: 'train', trickId: 'spin' }, day), /ごはんがありません/);
});

test('all five tricks require 51 food/1020 answers, yet the first study session produces progress', () => {
  let care = funded();
  let count = 0;
  for (const trick of COMPANION_TRICKS) {
    assert.equal(canTeachCompanionTrick(care, trick.id), true);
    for (let i = 0; i < trick.practices; i++) { care = applyCompanionCareAction(care, { kind: 'train', trickId: trick.id }, day); count++; }
    assert.equal(isCompanionTrickLearned(care, trick.id), true);
  }
  assert.equal(count, 51); assert.equal(count * COMPANION_BALANCE.answersPerFood, 1020);
  const first = applyCompanionCareAction(funded(1), { kind: 'train', trickId: 'spin' }, day);
  assert.equal(first.tricks.spin, 1); assert.equal(first.friendship, 3);
});

test('invalid saves cannot reset food/mastery or invent rewards; names can be edited', () => {
  const care = funded(2);
  assert.equal(parseCompanionCare(JSON.stringify(care)).food, 2);
  for (const invalid of [{ ...care, food: -1 }, { ...care, food: 3 }, { ...care, peakFriendship: -1 },
    { ...care, answerRemainder: 1 }, { ...care, lastSeenDay: '2026-02-30' },
    { ...care, tricks: { ...care.tricks, spin: 100 } }, { ...care, foodAwardAnswerIds: [] },
    { ...care, creditedAnswerIds: [...care.creditedAnswerIds, care.creditedAnswerIds[0]] }]) {
    assert.throws(() => parseCompanionCare(JSON.stringify(invalid)));
  }
  assert.equal(applyCompanionCareAction(care, { kind: 'rename', name: '  ぽん  ' }, day).name, 'ぽん');
  assert.throws(() => applyCompanionCareAction(care, { kind: 'rename', name: ' ' }, day));
});
