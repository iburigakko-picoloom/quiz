import test from 'node:test';
import assert from 'node:assert/strict';
import {splitAnswerExplanation,choiceReason,exampleAnswerExplanation} from '../src/utils/answerExplanation.ts';
import {buildSimpleCreationPrompt} from '../src/utils/simpleCreationPrompt.ts';
import {validateImportJson,CHATGPT_MATERIAL_TEMPLATE_PROMPT,CHATGPT_PAST_EXAM_TEMPLATE_PROMPT} from '../src/utils/importValidator.ts';

test('choice reasons follow text through shuffled and extra distractor choices',()=>{
 const text='全体の**概念**。\n\n### 選択肢：A\nAの根拠。\n\n### 選択肢：B\nBの根拠。\n\n### 選択肢：追加誤答\n追加の根拠。';
 const parsed=splitAnswerExplanation(text,['A','B','追加誤答']);
 assert.equal(parsed.important,'全体の**概念**。');
 assert.deepEqual(['追加誤答','A'].map(c=>choiceReason(parsed.reasons,c)),['追加の根拠。','Aの根拠。']);
 assert.equal(choiceReason(parsed.reasons,'未登録'),'');
});
test('legacy titles and points retain meaningful text without nested headings',()=>{
 const text='# 解説\n## 尿の生成と調節\n本文。\n### ポイント\n- 保存する説明\n\n| A | B |\n|---|---|\n| 1 | 2 |';
 const parsed=splitAnswerExplanation(text,[]);
 assert.ok(parsed.important.includes('尿の生成と調節：本文。'));assert.ok(parsed.important.includes('保存する説明'));
 assert.ok(parsed.important.includes('| 1 | 2 |'));assert.ok(!parsed.important.includes('#'));
 assert.equal(parsed.reasons.size,0);
});
test('unknown choice sections and fenced content remain visible without guessing mappings',()=>{
 const parsed=splitAnswerExplanation('説明\n### 選択肢：不明\n残す根拠\n```text\n# コード\n```',['A']);
 assert.ok(parsed.important.includes('不明'));assert.ok(parsed.important.includes('残す根拠'));assert.ok(parsed.important.includes('# コード'));
});
test('new explanation stays compatible with existing import JSON and generation requests',()=>{
 const choices=['A','B','C','D'],explanation=exampleAnswerExplanation(choices);
 const result=validateImportJson(JSON.stringify({setTitle:'検証',questions:[{question:'問題',choices,answerIndex:0,explanation}]}));
 assert.equal(result.ok,true);assert.equal(result.value.questions[0].explanation,explanation);
 const prompts=[buildSimpleCreationPrompt('作成'),CHATGPT_MATERIAL_TEMPLATE_PROMPT,CHATGPT_PAST_EXAM_TEMPLATE_PROMPT];
 for(const prompt of prompts){assert.ok(prompt.includes('### 選択肢：'));assert.ok(prompt.includes('オレンジ'));assert.ok(prompt.includes('「ポイント」欄も生成しません'));}
});
