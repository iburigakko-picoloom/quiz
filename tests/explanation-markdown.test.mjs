import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExplanationMedia, normalizeExplanationMarkdown } from '../src/utils/explanationMarkdown.ts';
import { explanationPrompt } from '../src/utils/weaknessNotes.ts';

test('tables with short separators, alignment and CRLF are extracted', () => {
  for (const separator of ['| - | - |', '| :-- | --: |', '| --- | --- |']) {
    const result = extractExplanationMedia(`結論\r\n\r\n| A | B |\r\n${separator}\r\n| 一 | 二 |`);
    assert.equal(result.media.length, 1);
    assert.ok(result.media[0].includes('| 一 | 二 |'));
    assert.ok(result.body.includes('結論'));
  }
});
test('markdown wrappers display as content but flow blocks remain intact', () => {
  assert.equal(extractExplanationMedia('```markdown\n| A | B |\n| --- | --- |\n| 一 | 二 |\n```').media.length, 1);
  const flow = '```flow\n確認 → 判断 → 結果\n```';
  assert.equal(normalizeExplanationMarkdown(flow), flow);
  assert.equal(extractExplanationMedia(flow).body, flow);
  assert.equal(extractExplanationMedia('| A | B |\n本文です').media.length, 0);
});
test('memo prompts ask for concise safe visual explanations', () => {
  const prompt = explanationPrompt({id:'test',targets:[]},{tables:true,images:false,examples:true});
  for (const phrase of ['150〜300字','赤い太字','言語名flow','JSONの外に表を書かない','HTMLや色指定タグは使わない']) assert.ok(prompt.includes(phrase));
  assert.ok(prompt.includes('全選択肢の解説は自動で追加しない'));
});

test('internal reply markers are hidden without removing explanation text', () => {
  assert.equal(normalizeExplanationMarkdown('以前の解説\n<!-- qm-reply:request:question%3Aid -->\n追加解説'), '以前の解説\n\n追加解説');
});
