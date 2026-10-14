import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPANION_BALANCE, COMPANION_TRICKS, createCompanionCare, parseCompanionCare, creditCompanionAnswers,
  refreshCompanionDay, applyCompanionCareAction, isCompanionTrickLearned, canTeachCompanionTrick,
  companionReactions, pickCompanionReaction, companionSessionFood, companionSessionTreats } from '../src/utils/companionCare.ts';

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
  assert.equal(next.version, 3); assert.equal(next.food, 9); assert.equal(next.answerRemainder, 18);
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

test('each trick enforces its friendship threshold without spending treats or erasing prior practice', () => {
  for (const trick of COMPANION_TRICKS) {
    const low = {...funded(), friendship: trick.minFriendship - .5, peakFriendship: 100, tricks: {...funded().tricks, [trick.id]: 1}};
    const before = structuredClone(low);
    assert.equal(canTeachCompanionTrick(low, trick.id), false);
    assert.throws(() => applyCompanionCareAction(low, {kind:'train', trickId:trick.id}, day), /なかよし度/);
    assert.deepEqual(low, before);
    const ready = {...low, friendship: trick.minFriendship};
    assert.equal(canTeachCompanionTrick(ready, trick.id), true);
    const next = applyCompanionCareAction(ready, {kind:'train', trickId:trick.id}, day);
    assert.equal(next.tricks[trick.id], 2);assert.equal(next.treats, ready.treats - 1);
    assert.equal(next.friendship, ready.friendship);assert.equal(next.food, ready.food);
    const decayed = refreshCompanionDay(ready, '2027-10-14');
    assert.equal(canTeachCompanionTrick(decayed, trick.id), false);
    assert.equal(decayed.tricks[trick.id], 1);
  }
});

test('learned tricks survive low friendship and zero treats and cannot consume another training reward', () => {
  let care = {...funded(),friendship:100,peakFriendship:100};
  let count=0;
  for (const trick of COMPANION_TRICKS) {
    for(let i=0;i<trick.practices;i++){care=applyCompanionCareAction(care,{kind:'train',trickId:trick.id},day);count++;}
    assert.equal(isCompanionTrickLearned(care,trick.id),true);
  }
  assert.equal(count,51);assert.equal(care.treats,9);assert.equal(care.food,60);assert.equal(care.friendship,100);
  const restored=parseCompanionCare(JSON.stringify({...refreshCompanionDay(care,'2027-10-14'),treats:0}));
  for(const trick of COMPANION_TRICKS){
    assert.equal(isCompanionTrickLearned(restored,trick.id),true);
    assert.throws(()=>applyCompanionCareAction(restored,{kind:'train',trickId:trick.id},'2027-10-14'),/習得済み/);
  }
  assert.throws(()=>applyCompanionCareAction({...createCompanionCare(day),friendship:8,peakFriendship:8},{kind:'train',trickId:'spin'},day),/おやつがありません/);
});

test('food and treats remain independent after reaching a training threshold', () => {
  const original={...funded(1),friendship:80,peakFriendship:80};
  const fed=applyCompanionCareAction(original,{kind:'feed'},day);
  const trained=applyCompanionCareAction(fed,{kind:'train',trickId:'sleep'},day);
  assert.equal(trained.food,0);assert.equal(trained.treats,0);assert.equal(trained.friendship,84);assert.equal(trained.tricks.sleep,1);
  const firstTrain=applyCompanionCareAction(original,{kind:'train',trickId:'roll'},day);
  const thenFeed=applyCompanionCareAction(firstTrain,{kind:'feed'},day);
  assert.deepEqual(thenFeed.tricks,firstTrain.tricks);assert.equal(thenFeed.treats,0);assert.equal(thenFeed.friendship,84);
});

test('v2 grants initial treats once and reports only new answer rewards', () => {
  const { treats, treatRewardBaseline, ...old } = funded(2);
  const migrated = parseCompanionCare(JSON.stringify({ ...old, version: 2, food: 1, friendship: 12, peakFriendship: 12 }));
  assert.equal(migrated.food, 1); assert.equal(migrated.treats, 1); assert.equal(migrated.friendship, 12);
  assert.equal(companionSessionTreats(migrated, migrated.foodAwardAnswerIds), 0);
  const spent = applyCompanionCareAction(migrated, { kind: 'train', trickId: 'spin' }, day);
  const restored = parseCompanionCare(JSON.stringify(spent));
  assert.equal(restored.treats, 0);
  assert.equal(creditCompanionAnswers(restored, logs(100)), restored);
  const earned = creditCompanionAnswers(restored, logs(50, 'new'));
  assert.equal(earned.food, 2); assert.equal(earned.treats, 1);
  assert.equal(companionSessionTreats(earned, [...earned.foodAwardAnswerIds, ...earned.foodAwardAnswerIds]), 1);
  assert.deepEqual(parseCompanionCare(JSON.stringify(earned)), earned);
});

test('invalid saves cannot reset food/mastery or invent rewards; names can be edited', () => {
  const care = funded(2);
  assert.equal(parseCompanionCare(JSON.stringify(care)).food, 2);
  for (const invalid of [{ ...care, treats: -1 }, { ...care, treats: 3 }, { ...care, treatRewardBaseline: null }, { ...care, treatRewardBaseline: { awards: 3, treats: 1 } }, { ...care, food: -1 }, { ...care, food: 3 }, { ...care, peakFriendship: -1 },
    { ...care, answerRemainder: 1 }, { ...care, lastSeenDay: '2026-02-30' },
    { ...care, tricks: { ...care.tricks, spin: 100 } }, { ...care, foodAwardAnswerIds: [] },
    { ...care, creditedAnswerIds: [...care.creditedAnswerIds, care.creditedAnswerIds[0]] }]) {
    assert.throws(() => parseCompanionCare(JSON.stringify(invalid)));
  }
  assert.equal(applyCompanionCareAction(care, { kind: 'rename', name: '  ぽん  ' }, day).name, 'ぽん');
  assert.throws(() => applyCompanionCareAction(care, { kind: 'rename', name: ' ' }, day));
});
