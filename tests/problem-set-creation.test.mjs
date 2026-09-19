import assert from 'node:assert/strict';
import test from 'node:test';
import { insertMaterialPage, moveMaterialPage, normalizeMaterialReferences, materialReferencePrompt, validMaterialRecord, linkQuestionMaterialPage } from '../src/utils/materialModel.ts';

test('binding a material page preserves question content, progress and other references', () => {
  const reference = { materialId: 'material-1', pageId: 'page-b' };
  const other = { materialId: 'material-2', pageId: 'page-a' };
  const question = { id: 'q1', question: '問題', explanation: '通常の解説', detailedExplanation: '詳細解説', materialReferences: [other] };
  const untouched = { id: 'q2', question: '別の問題' };
  const data = { questions: [question, untouched], progress: { q1: { level: 3 } }, logs: ['keep'], problemSets: [{ id: 'set' }] };
  const linked = linkQuestionMaterialPage(data, 'q1', reference, true, 'today');
  assert.deepEqual(linked.questions[0], { ...question, materialReferences: [reference, other], updatedAt: 'today' });
  assert.equal(linked.questions[1], untouched);
  assert.equal(linked.progress, data.progress);
  assert.equal(linked.logs, data.logs);
  assert.equal(linked.problemSets, data.problemSets);
  assert.deepEqual(data.questions[0].materialReferences, [other]);
  const repeated = linkQuestionMaterialPage(linked, 'q1', reference, true, 'today');
  assert.deepEqual(repeated.questions[0].materialReferences, [reference, other]);
  const unlinked = linkQuestionMaterialPage(repeated, 'q1', reference, false, 'tomorrow');
  assert.deepEqual(unlinked.questions[0].materialReferences, [other]);
  assert.throws(() => linkQuestionMaterialPage(data, 'missing', reference, true, 'today'));
  assert.throws(() => linkQuestionMaterialPage(data, 'q1', { materialId: '', pageId: 'page' }, true, 'today'));
});

test('material references survive insertion and reordering without changing source PDF pages', () => {
  const source = { id: 'material-1', title: '資料', pages: [{ id: 'page-a', kind: 'pdf', pdfPage: 1 }, { id: 'page-b', kind: 'pdf', pdfPage: 2 }] };
  const inserted = insertMaterialPage(source, { id: 'blank', kind: 'blank' }, 0);
  const moved = moveMaterialPage(inserted, 'page-b', 0);
  const reference = normalizeMaterialReferences([{ materialId: source.id, pageId: 'page-b' }])[0];
  assert.equal(moved.pages.find(page => page.id === reference.pageId).pdfPage, 2);
  assert.equal(source.pages.length, 2);
  assert.match(materialReferencePrompt(moved), /"pdfPage":2,"pageId":"page-b"/);
  assert.equal(validMaterialRecord({ kind: 'quiz-material-index', version: 1, problemSetId: 'set', materials: [moved], updatedAt: '2026-09-19' }), true);
  assert.equal(validMaterialRecord({ kind: 'quiz-material-index', version: 1, problemSetId: 'set', materials: [{ ...source, pages: [source.pages[0], source.pages[0]] }], updatedAt: '2026-09-19' }), false);
});

test('question JSON retains structured references and rejects malformed IDs', () => {
  const question = { question: '問題', choices: ['a', 'b', 'c', 'd'], answerIndex: 0, explanation: '解説', materialReferences: [{ materialId: 'material-1', pageId: 'page-b' }] };
  const result = validateImportJson(JSON.stringify({ setTitle: 'テスト', questions: [question] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.questions[0].materialReferences, question.materialReferences);
  assert.equal(validateImportJson(JSON.stringify({ setTitle: 'テスト', questions: [{ ...question, materialReferences: [{ materialId: 'x', pageId: 2 }] }] })).ok, false);
});
import {
  getDraftAnswerIndexes,
  getDraftIssues,
  parseBulkQuestionText,
  parseQuestionCsv,
} from '../src/utils/bulkQuestionParser.ts';
import {
  getImportFileSelectionError,
  IMPORT_RESOURCE_LIMITS,
  validateImportJson,
} from '../src/utils/importValidator.ts';

test('plain text parser reads multiple questions without guessing missing answers', () => {
  const result = parseBulkQuestionText(`
1. 日本の首都はどこですか。
A. 大阪
B. 東京
C. 京都
D. 名古屋
正解: B
解説: 日本の首都は東京です。
分類: 地理

2. 2 + 2 はいくつですか。
A. 2
B. 3
C. 4
D. 5
解説: 足し算の問題です。
`);

  assert.equal(result.questions.length, 2);
  assert.equal(result.validCount, 1);
  assert.equal(result.needsReviewCount, 1);
  assert.equal(result.questions[0].answerIndex, 1);
  assert.equal(result.questions[0].category, '地理');
  assert.equal(result.questions[1].answerIndex, null);
  assert.match(result.questions[1].issues.join(' '), /正解/);
});

test('answer text must exactly identify a choice', () => {
  const result = parseBulkQuestionText(`
Q1 次から正しいものを選んでください
1) 赤
2) 青
3) 緑
4) 白
答え: 緑
`);
  assert.equal(result.questions[0].answerIndex, 2);

  const unresolved = parseBulkQuestionText(`
Q1 次から正しいものを選んでください
1) 赤
2) 青
3) 緑
4) 白
答え: たぶん青
`);
  assert.equal(unresolved.questions[0].answerIndex, null);
});

test('draft validation accepts only four or five non-empty choices and an explicit answer', () => {
  assert.deepEqual(getDraftIssues({ question: '問題', choices: ['1', '2', '3', '4'], answerIndex: 0 }), []);
  assert.ok(getDraftIssues({ question: '問題', choices: ['1', '2', ''], answerIndex: null }).length >= 2);
});

function createValidImportQuestion(overrides = {}) {
  return {
    question: '問題文',
    choices: ['選択肢1', '選択肢2', '選択肢3', '選択肢4'],
    answerIndex: 0,
    explanation: '解説',
    ...overrides,
  };
}

test('JSON import resource limits keep normal explanations and markdown tables compatible', () => {
  const result = validateImportJson(JSON.stringify({
    setTitle: '通常の問題セット',
    source: '講義資料',
    questions: [createValidImportQuestion({
      detailedExplanation: '| 項目 | 内容 |\n| --- | --- |\n| A | 詳細解説 |',
    })],
  }));
  assert.equal(result.ok, true);
});

test('JSON import rejects excessive question counts and oversized major strings', () => {
  const tooManyQuestions = validateImportJson(JSON.stringify({
    questions: Array.from({ length: IMPORT_RESOURCE_LIMITS.maxQuestions + 1 }, () => ({})),
  }));
  assert.equal(tooManyQuestions.ok, false);
  if (!tooManyQuestions.ok) assert.match(tooManyQuestions.errors.join(' '), /2,000問以下/);

  const oversizedQuestion = validateImportJson(JSON.stringify({
    questions: [createValidImportQuestion({
      question: '問'.repeat(IMPORT_RESOURCE_LIMITS.question + 1),
      choices: ['選択肢1', '選択肢2', '選択肢3', '選択肢4'],
    })],
  }));
  assert.equal(oversizedQuestion.ok, false);
  if (!oversizedQuestion.ok) assert.match(oversizedQuestion.errors.join(' '), /question は20,000文字以下/);

  const oversizedChoice = validateImportJson(JSON.stringify({
    questions: [createValidImportQuestion({
      choices: ['選'.repeat(IMPORT_RESOURCE_LIMITS.choice + 1), '2', '3', '4'],
    })],
  }));
  assert.equal(oversizedChoice.ok, false);
  if (!oversizedChoice.ok) assert.match(oversizedChoice.errors.join(' '), /choices\[0\] は10,000文字以下/);

  const oversizedDetailedExplanation = validateImportJson(JSON.stringify({
    questions: [createValidImportQuestion({
      detailedExplanation: '詳'.repeat(IMPORT_RESOURCE_LIMITS.detailedExplanation + 1),
    })],
  }));
  assert.equal(oversizedDetailedExplanation.ok, false);
  if (!oversizedDetailedExplanation.ok) {
    assert.match(oversizedDetailedExplanation.errors.join(' '), /detailedExplanation は250,000文字以下/);
  }
});

test('JSON import rejects raw payloads before parsing when they exceed the text budget', () => {
  const result = validateImportJson(' '.repeat(IMPORT_RESOURCE_LIMITS.maxJsonCharacters + 1));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(' '), /JSONが大きすぎます/);
});

test('file selection limits account for existing files and replacement duplicates', () => {
  const mib = 1024 * 1024;
  assert.match(
    getImportFileSelectionError([], [{ id: 'large', name: 'large.json', size: 8 * mib + 1 }]),
    /1ファイルの上限/,
  );
  assert.match(
    getImportFileSelectionError(
      Array.from({ length: IMPORT_RESOURCE_LIMITS.maxFiles }, (_, index) => ({ id: `old-${index}`, name: `${index}.json`, size: 1 })),
      [{ id: 'new', name: 'new.json', size: 1 }],
    ),
    /20件まで/,
  );
  assert.match(
    getImportFileSelectionError(
      [{ id: 'one', name: 'one.json', size: 8 * mib }],
      [
        { id: 'two', name: 'two.json', size: 8 * mib },
        { id: 'three', name: 'three.json', size: 8 * mib },
        { id: 'four', name: 'four.json', size: 1 },
      ],
    ),
    /合計は24MB以下/,
  );
  assert.equal(
    getImportFileSelectionError(
      [{ id: 'same', name: 'old.json', size: 8 * mib }],
      [{ id: 'same', name: 'replacement.json', size: 1 }],
    ),
    null,
  );
});

test('CSV import stays in the reviewed creation path', () => {
  const result = parseQuestionCsv('問題文,選択肢1,選択肢2,選択肢3,選択肢4,正解,解説,分類\n"2, 3, 5の次は?",7,8,9,10,7,素数の並び,数学');
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].question, '2, 3, 5の次は?');
  assert.equal(result.questions[0].answerIndex, 0);
  assert.equal(result.validCount, 1);
});

test('plain text import keeps multiple label answers sorted and preserves the primary answer', () => {
  const result = parseBulkQuestionText(`
Q1 Select both even numbers.
A. one
B. two
C. three
D. four
Answer: D、B
Explanation: Two and four are even.
`);

  assert.equal(result.validCount, 1);
  assert.equal(result.needsReviewCount, 0);
  assert.equal(result.questions[0].answerIndex, 1);
  assert.deepEqual(result.questions[0].answerIndexes, [1, 3]);
  assert.deepEqual(getDraftAnswerIndexes(result.questions[0]), [1, 3]);
});

test('plain text import accepts multiple exact choice texts', () => {
  const result = parseBulkQuestionText(`
Q1 Select the warm colors.
A. red
B. blue
C. orange
D. green
Answer: red / orange
`);

  assert.equal(result.validCount, 1);
  assert.equal(result.questions[0].answerIndex, 0);
  assert.deepEqual(result.questions[0].answerIndexes, [0, 2]);
});

test('CSV import reads a quoted multiple-answer field and quoted commas', () => {
  const result = parseQuestionCsv([
    'question,choice1,choice2,choice3,choice4,answer,explanation',
    '"Select the vowels, in this row",A,B,E,G,"A, C","A and E are vowels, here."',
  ].join('\n'));

  assert.equal(result.validCount, 1);
  assert.equal(result.needsReviewCount, 0);
  assert.equal(result.questions[0].question, 'Select the vowels, in this row');
  assert.equal(result.questions[0].explanation, 'A and E are vowels, here.');
  assert.equal(result.questions[0].answerIndex, 0);
  assert.deepEqual(result.questions[0].answerIndexes, [0, 2]);
});

test('CSV import supports multiple answers across all five choices', () => {
  const result = parseQuestionCsv([
    'question,choice1,choice2,choice3,choice4,choice5,answer',
    'Select two positions,first,second,third,fourth,fifth,"B, E"',
  ].join('\n'));

  assert.equal(result.validCount, 1);
  assert.equal(result.questions[0].choices.length, 5);
  assert.deepEqual(result.questions[0].answerIndexes, [1, 4]);
});

test('draft validation rejects a multiple-answer index outside the choice range', () => {
  const draft = {
    question: 'Select valid positions.',
    choices: ['first', 'second', 'third', 'fourth'],
    answerIndex: 0,
    answerIndexes: [0, 4],
  };

  assert.deepEqual(getDraftAnswerIndexes(draft), [0]);
  assert.ok(getDraftIssues(draft).length > 0);
});

test('plain text import does not silently discard an out-of-range answer label', () => {
  const result = parseBulkQuestionText(`
Q1 Select the first choice.
A. first
B. second
C. third
D. fourth
Answer: A, E
`);

  assert.equal(result.validCount, 0);
  assert.equal(result.needsReviewCount, 1);
  assert.ok(result.questions[0].issues.some((issue) => issue.includes('範囲外')));
});

test('CSV import reports an unclosed quoted field', () => {
  const result = parseQuestionCsv([
    'question,choice1,choice2,choice3,choice4,answer',
    '"This quote never closes,first,second,third,fourth,A',
  ].join('\n'));

  assert.equal(result.validCount, 0);
  assert.ok(result.errors?.some((error) => error.includes('閉じられていません')));
});

test('answer labels take precedence when choice text itself is a label', () => {
  const result = parseBulkQuestionText(`
Q1 Which position is labelled A?
A. B
B. A
C. C
D. D
Answer: A
`);

  assert.equal(result.validCount, 1);
  assert.equal(result.questions[0].answerIndex, 0);
});
