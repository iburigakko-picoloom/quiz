import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImportJson } from '../src/utils/importValidator.ts';
import { getAnswerText, getChoiceText, stripChoicePrefix } from '../src/utils/quiz.ts';

test('import and display preserve choice text that resembles a label', () => {
  const choices = ['E. coli', '1.5 mg', '1:2', 'A. baumannii', '3.14'];
  const result = validateImportJson(JSON.stringify({
    setTitle: 'test',
    questions: [{ question: 'question', choices, answerIndex: 0, explanation: 'explanation' }],
  }));
  assert.equal(result.ok, true);
  const question = result.value.questions[0];
  assert.deepEqual(question.choices, choices);
  assert.equal(question.answerText, 'E. coli');
  assert.deepEqual(choices.map((_, index) => getChoiceText(question, index)), choices);
  assert.equal(getAnswerText(question), '1. E. coli');

  const labelled = validateImportJson(JSON.stringify({
    questions: [{ question: 'question', choices: ['1. E. coli', '2. 1.5 mg', '3: 1:2', '4)選択肢'], answerIndex: 0, explanation: 'explanation' }],
  }));
  assert.equal(labelled.ok, true);
  assert.deepEqual(labelled.value.questions[0].choices, choices.slice(0, 3).concat('選択肢'));
  assert.deepEqual(labelled.value.questions[0].choices.map((_, index) => getChoiceText(labelled.value.questions[0], index)), choices.slice(0, 3).concat('選択肢'));
});

test('unambiguous labels are removed without stripping the following value', () => {
  for (const [input, expected] of [
    ['1. E. coli', 'E. coli'], ['2. 1.5 mg', '1.5 mg'], ['3: 1:2', '1:2'],
    ['A)選択肢', '選択肢'], ['ｂ） 選択肢', '選択肢'], ['４． 選択肢', '選択肢'],
    ['1.5 mg', '1.5 mg'], ['1:2', '1:2'], ['E. coli', 'E. coli'],
    ['１．５ mg', '１．５ mg'],
    ['  A. choice  ', 'A. choice'],
  ]) {
    assert.equal(stripChoicePrefix(input), expected, input);
    assert.equal(stripChoicePrefix(expected), expected, `second pass: ${input}`);
  }
});
