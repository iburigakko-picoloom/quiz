import test from 'node:test';
import assert from 'node:assert/strict';
import { randomizeQuestionChoices } from '../src/utils/choiceRandomization.ts';
import { validateImportJson } from '../src/utils/importValidator.ts';
import { buildSimpleCreationPrompt } from '../src/utils/simpleCreationPrompt.ts';

const question = { id: 'q', question: '語義', choices: ['正解', '誤答1', '誤答2', '誤答3'], answerIndex: 0, explanation: '根拠', distractors: ['誤答4', '誤答5', '誤答6'], shuffleChoices: true };
test('sampling preserves the answer, remaps indexes and does not mutate the source', () => {
  const before = JSON.stringify(question);
  const variants = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    let state = seed;
    const result = randomizeQuestionChoices(question, () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32));
    assert.equal(result.choices.length, 4);
    assert.equal(new Set(result.choices).size, 4);
    assert.equal(result.choices[result.answerIndex], '正解');
    variants.add(JSON.stringify(result.choices));
  }
  assert.ok(variants.size > 10);
  assert.equal(JSON.stringify(question), before);
});
test('multiple answers stay present and legacy questions remain unchanged', () => {
  const multiple = { ...question, answerIndexes: [0, 1] };
  const result = randomizeQuestionChoices(multiple, () => 0.2);
  assert.deepEqual(result.answerIndexes.map((index) => result.choices[index]).sort(), ['正解', '誤答1'].sort());
  const legacy = { ...question, distractors: undefined, shuffleChoices: undefined };
  assert.equal(randomizeQuestionChoices(legacy), legacy);
  const disabled = { ...question, shuffleChoices: false };
  assert.equal(randomizeQuestionChoices(disabled), disabled);
});
test('JSON imports keep randomization metadata and reject invalid pools', () => {
  const parse = (q) => validateImportJson(JSON.stringify({ setTitle: '単語', questions: [q] }));
  const parsed = parse(question);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.questions[0].distractors, question.distractors);
  assert.equal(parsed.value.questions[0].shuffleChoices, true);
  for (const distractors of [['正解'], [1], [''], Array(51).fill('誤答')]) assert.equal(parse({ ...question, distractors }).ok, false);
  assert.equal(parse({ ...question, shuffleChoices: 'true' }).ok, false);
});
test('simple request prompt includes the request and compatible sampling fields', () => {
  const prompt = buildSimpleCreationPrompt('古文単語の問題集を作って');
  assert.ok(prompt.includes('古文単語の問題集を作って'));
  assert.ok(prompt.includes('"distractors"'));
  assert.ok(prompt.includes('"shuffleChoices":true'));
});
