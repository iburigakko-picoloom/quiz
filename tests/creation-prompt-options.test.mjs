import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCreationConditions, buildSimpleCreationPrompt } from '../src/utils/simpleCreationPrompt.ts';
import { CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT, validateImportJson } from '../src/utils/importValidator.ts';

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

test('all creation modes request a complete first reply and valid import examples', () => {
  for (const prompt of [buildSimpleCreationPrompt('古文単語'), CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT]) {
    assert.ok(prompt.includes('原則1回の回答で完成したJSON'));
    assert.ok(prompt.includes('JSON本体を1個だけ'));
    assert.ok(prompt.includes('未収録'));
    const example = prompt.split('\n').find(line => line.startsWith('{'));
    assert.equal(validateImportJson(example).ok, true);
  }
  const past = CHATGPT_PAST_EXAM_TEMPLATE_PROMPT;
  assert.ok(past.includes('長さや文体をそろえるための書き換え、追加誤答の生成はしない'));
  assert.ok(past.includes('単一回答への変換はしない'));
  assert.ok(past.includes('shuffleChoicesをfalse'));
  assert.ok(!past.includes('確認できるまで出力を完了しない'));
  assert.ok(!CHATGPT_MATERIAL_TEMPLATE_PROMPT.includes('病態・機序 → 検査・診断'));
});

test('memo practice has its own source section and keeps question output format', () => {
  const context = JSON.stringify([{疑問:['AとBの違い'],元の問題:'元問題'}]);
  const prompt = buildSimpleCreationPrompt('復習問題', {choiceCount:5,questionCount:12,allowMultiple:true}, context);
  assert.ok(prompt.includes(context));
  assert.ok(prompt.includes('条件・具体例を変えて'));
  assert.ok(prompt.includes('メモの誤解を正解として採用しない'));
  assert.ok(prompt.includes('問題作成用のquestions形式'));
  assert.ok(!buildSimpleCreationPrompt('普通の問題').includes('【苦手メモからの問題化】'));
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
