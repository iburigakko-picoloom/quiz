import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCreationConditions, buildSimpleCreationPrompt } from '../src/utils/simpleCreationPrompt.ts';
import { CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT, validateImportJson } from '../src/utils/importValidator.ts';

test('copied prompts include each combination of selected conditions', () => {
  for (const choiceCount of [4, 5]) for (const questionCount of [1, 35, 2000]) for (const allowMultiple of [false, true]) {
    const options = { choiceCount, questionCount, allowMultiple };
    const simple = buildSimpleCreationPrompt('古文単語を作って', options);
    assert.ok(simple.includes('古文単語を作って'));
    const example = JSON.parse(simple.split('\n').find((line) => line.startsWith('{')));
    assert.equal(example.questions[0].choices.length, choiceCount);
    for (const prompt of [simple, applyCreationConditions(CHATGPT_MATERIAL_TEMPLATE_PROMPT, options)]) {
      assert.ok(prompt.includes(`問題数：${questionCount}問`));
      assert.ok(prompt.includes(`必ず${choiceCount}個`));
      assert.ok(prompt.includes(allowMultiple ? '複数回答を実際に含めてください' : '複数回答問題は作らないでください'));
      assert.equal(prompt.split('【今回の作成条件】').length - 1, 1);
      const sample = JSON.parse(prompt.split('\n').find(line => line.startsWith('{')));
      const question = sample.questions[0];
      assert.equal(question.choices.length, choiceCount);
      assert.ok(question.explanation.includes('**'));
      if (allowMultiple) {
        assert.deepEqual(question.answerIndexes, [0, 1]);
        assert.equal(question.answerIndex, undefined);
        assert.ok(question.question.includes('すべて選べ'));
      } else {
        assert.equal(question.answerIndex, 0);
        assert.equal(question.answerIndexes, undefined);
      }
      const imported = validateImportJson(JSON.stringify(sample));
      assert.equal(imported.ok, true);
      assert.deepEqual(imported.value.questions[0].answerIndexes, allowMultiple ? [0, 1] : [0]);
      assert.equal(imported.value.questions[0].explanation, question.explanation);
    }
  }
});

test('all creation modes request a complete first reply and valid import examples', () => {
  for (const prompt of [buildSimpleCreationPrompt('古文単語'), CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT]) {
    assert.ok(prompt.includes('原則1回の回答で完成したJSONファイル'));
    assert.ok(prompt.includes('ファイル内はJSON本体を1個だけ'));
    assert.ok(prompt.includes('quiz-make.json'));
    assert.ok(prompt.includes('JSON全文や作成コードは表示しません'));
    assert.ok(prompt.includes('架空の添付やリンクは作らない'));
    assert.ok(!prompt.includes('JSONを直接返してください'));
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

test('ordinary explanation emphasis is red and survives JSON import', () => {
  for (const prompt of [buildSimpleCreationPrompt('古文単語'), CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT]) {
    assert.ok(prompt.includes('1問あたり1〜3箇所だけ**太字**'));
    assert.ok(prompt.includes('赤い太字'));
    assert.ok(prompt.includes('HTMLや色指定タグは使わない'));
    const sample = JSON.parse(prompt.split('\n').find(line => line.startsWith('{')));
    sample.questions[0].explanation = '**重要語**を覚える。';
    const result = validateImportJson(JSON.stringify(sample));
    assert.equal(result.ok, true);
    assert.equal(result.value.questions[0].explanation, '**重要語**を覚える。');
  }
});

test('question totals are guidance, while explanations teach reasoning without a hard length cap', () => {
  const simple = buildSimpleCreationPrompt('古文単語');
  const conditions = simple;
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

test('copy routing applies conditions once and preserves the past-exam original format', () => {
  const screen = readFileSync(new URL('../src/screens/CreateProblemSetScreen.tsx', import.meta.url), 'utf8');
  assert.match(screen, /writeClipboardText\(kind !== 'material'\s*\? template\s*: applyCreationConditions/);
  const simple = buildSimpleCreationPrompt('古文単語');
  assert.ok(simple.length < 2200);
  assert.ok(simple.indexOf('【通常解説の強調】') < simple.indexOf('【学習者の依頼】'));
  for (const prompt of [CHATGPT_MATERIAL_TEMPLATE_PROMPT, CHATGPT_PAST_EXAM_TEMPLATE_PROMPT]) {
    const sample = JSON.parse(prompt.split('\n').find(line => line.startsWith('{')));
    assert.ok(sample.questions[0].explanation.includes('**'));
  }
});
