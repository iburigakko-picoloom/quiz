import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCreationConditions, buildSimpleCreationPrompt } from '../src/utils/simpleCreationPrompt.ts';
import { CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT } from '../src/utils/importValidator.ts';

test('copied prompts include each combination of selected conditions', () => {
  for (const choiceCount of [4, 5]) for (const questionCount of [1, 35, 2000]) for (const allowMultiple of [false, true]) {
    const options = { choiceCount, questionCount, allowMultiple };
    const simple = buildSimpleCreationPrompt('古文単語を作って', options);
    assert.ok(simple.includes('古文単語を作って'));
    const example = JSON.parse(simple.split('\n').find((line) => line.startsWith('{')));
    assert.equal(example.questions[0].choices.length, choiceCount);
    assert.ok(simple.includes(`${questionCount}問・${choiceCount}択`));
    for (const template of [simple, CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT]) {
      const prompt = applyCreationConditions(template, options);
      assert.ok(prompt.includes(`問題数：${questionCount}問`));
      assert.ok(prompt.includes(`必ず${choiceCount}個`));
      assert.ok(prompt.includes(allowMultiple ? '複数回答の問題を含めても構いません' : '複数回答問題は作らないでください'));
    }
  }
});

test('question totals are guidance, while explanations teach reasoning without a hard length cap', () => {
  const simple = buildSimpleCreationPrompt('古文単語');
  const conditions = applyCreationConditions(simple, { choiceCount: 4, questionCount: 20, allowMultiple: false });
  assert.ok(conditions.includes('厳密に一致させる必要はありません'));
  assert.ok(conditions.includes('数合わせの重複・水増し'));
  for (const prompt of [simple, CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT]) {
    assert.ok(prompt.includes('300〜600字程度'));
    assert.ok(prompt.includes('文字数の上限にはしない'));
    assert.ok(prompt.includes('途中式'));
    assert.ok(prompt.includes('後半の解説を省略しない'));
    assert.ok(!prompt.includes('120〜240字'));
  }
});
