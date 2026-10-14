import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPANION_BALANCE, COMPANION_TRICKS, createCompanionCare, parseCompanionCare, creditCompanionAnswers,
  refreshCompanionDay, applyCompanionCareAction, isCompanionTrickLearned, canTeachCompanionTrick,
  companionReactions, pickCompanionReaction, companionSessionFood } from '../src/utils/companionCare.ts';

const day = '2026-10-14';
const logs = (count, prefix = 'answer') => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, isCorrect: i % 2 === 0 }));
const funded = (food = 60) => creditCompanionAnswers(createCompanionCare(day), logs(food * COMPANION_BALANCE.answersPerFood));
const legacy = (count = 338) => {
  const { rewardBaseline, ...base } = createCompanionCare(day);
  return { ...base, version: 1, name: 'ぽん', creditedAnswerIds: logs(count).map(log => log.id),
    foodAwardAnswerIds: logs(count).filter((_, i) => (i + 1) % 20 === 0).map(log => log.id),
    food: Math.floor(count / 20) - 7, answerRemainder: count % 20, friendship: 30.5, peakFriendship: 30.5,
    tricks: { ...base.tricks, spin: 3 } };
};

test('the 20-answer save migrates without spending food or losing bond, mastery, witnesses or remainder', () => {
  const old = legacy(), next = parseCompanionCare(JSON.stringify(old));
  assert.equal(next.version, 2); assert.equal(next.food, 9); assert.equal(next.answerRemainder, 18);
  assert.equal(next.name, old.name); assert.equal(next.friendship, old.friendship);
  assert.deepEqual(next.tricks, old.tricks); assert.deepEqual(next.creditedAnswerIds, old.creditedAnswerIds);
  assert.deepEqual(next.foodAwardAnswerIds, old.foodAwardAnswerIds);
  assert.deepEqual(parseCompanionCare(JSON.stringify(next)), next);
  const pending = creditCompanionAnswers(next, [...logs(338), ...logs(31, 'new')]);
  assert.equal(pending.food, 9); assert.equal(pending.answerRemainder, 49);
  const earned = creditCompanionAnswers(pending, logs(32, 'new'));
  assert.equal(earned.food, 10); assert.equal(earned.answerRemainder, 0);
  assert.deepEqual(parseCompanionCare(JSON.stringify(earned)), earned);
});

test('invalid legacy balances are rejected before migration', () => {
  const old = legacy();
  for (const value of [{ ...old, answerRemainder: 49 }, { ...old, food: 17 }, { ...old, foodAwardAnswerIds: [] }]) {
    assert.throws(() => parseCompanionCare(JSON.stringify(value)));
  }
});

test('explicit reset clears care only, preserves the name and old answer witnesses, and starts a new 50-answer cycle', () => {
  const old = parseCompanionCare(JSON.stringify(legacy()));
  const reset = applyCompanionCareAction(old, { kind: 'reset' }, day);
  assert.equal(reset.name, 'ぽん'); assert.equal(reset.food, 0); assert.equal(reset.friendship, 0);
  assert.equal(reset.peakFriendship, 0); assert.equal(reset.answerRemainder, 0);
  assert.deepEqual(reset.tricks, createCompanionCare(day).tricks);
  assert.deepEqual(reset.creditedAnswerIds, old.creditedAnswerIds);
  assert.deepEqual(parseCompanionCare(JSON.stringify(reset)), reset);
  assert.equal(creditCompanionAnswers(reset, logs(338)), reset);
  assert.equal(companionSessionFood(reset, old.foodAwardAnswerIds), 0);
  const next = creditCompanionAnswers(reset, [...logs(338), ...logs(49, 'new')]);
  assert.equal(next.food, 0); assert.equal(next.answerRemainder, 49);
  const earned = creditCompanionAnswers(next, logs(50, 'new'));
  assert.equal(earned.food, 1); assert.equal(earned.answerRemainder, 0);
  assert.deepEqual(parseCompanionCare(JSON.stringify(earned)), earned);
  assert.equal(old.food, 9, 'the source snapshot is unchanged');
});

test('correct, incorrect and repeated-question review answers earn every 50 unique saved IDs; remainder survives a new day', () => {
  const first = creditCompanionAnswers(createCompanionCare(day), logs(49));
  assert.equal(first.food, 0); assert.equal(first.answerRemainder, 49);
  const restored = parseCompanionCare(JSON.stringify(refreshCompanionDay(first, '2026-10-15', true)));
  const next = creditCompanionAnswers(restored, [...logs(49), ...logs(2, 'review')]);
  assert.equal(next.food, 1); assert.equal(next.answerRemainder, 1); assert.equal(next.creditedAnswerIds.length, 51);
  assert.equal(creditCompanionAnswers(next, [...logs(49), ...logs(2, 'review')]), next);
  assert.equal(companionSessionFood(next, ['review-0', 'review-0', 'review-1']), 1);
});

test('duplicate history, result reopen, deletion and restoring previously rewarded IDs cannot produce extra food', () => {
  let care = creditCompanionAnswers(createCompanionCare(day), [...logs(100), ...logs(100)]);
  assert.equal(care.food, 2);
  care = applyCompanionCareAction(care, { kind: 'feed' }, day);
  assert.equal(care.food, 1);
  assert.equal(creditCompanionAnswers(care, []), care);
  assert.equal(creditCompanionAnswers(parseCompanionCare(JSON.stringify(care)), logs(100)).food, 1);
  assert.equal(companionSessionFood(care, ['answer-49', 'answer-99']), 2);
  assert.equal(companionSessionFood(care, ['preview-19']), 0);
});

test('batch completion pays all earned food, and stored food never expires', () => {
  let care = creditCompanionAnswers(createCompanionCare(day), logs(255));
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

test('all five tricks require 51 food/2550 answers, yet the first study session produces progress', () => {
  let care = funded();
  let count = 0;
  for (const trick of COMPANION_TRICKS) {
    assert.equal(canTeachCompanionTrick(care, trick.id), true);
    for (let i = 0; i < trick.practices; i++) { care = applyCompanionCareAction(care, { kind: 'train', trickId: trick.id }, day); count++; }
    assert.equal(isCompanionTrickLearned(care, trick.id), true);
  }
  assert.equal(count, 51); assert.equal(count * COMPANION_BALANCE.answersPerFood, 2550);
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
