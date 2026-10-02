import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';

const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
    && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
after(() => hook.deregister());
const { recordConflictTitle, describeRecordConflictValue, recordConflictIdentity, retainRecordConflictChoices } =
  await import('../src/utils/recordConflictPresentation.ts');
const key = (collection, id) => JSON.stringify([collection, id]);
const rows = new Map([
  [key('questions', 'q_internal-id'), { raw: JSON.stringify({ id: 'q_internal-id', setId: 'set_internal-id', question: '酸素の元素記号は？' }) }],
  [key('problemSets', 'set_internal-id'), { raw: JSON.stringify({ title: '化学の基礎' }) }],
]);
const conflict = { key: key('progress', 'q_internal-id'), operationId: 'operation', local: { position: 0, raw: '{"answeredCount":1}' },
  remote: { collection: 'progress', id: 'q_internal-id', revision: 2, position: 0, raw: '{"answeredCount":0}' } };

test('progress and answer-log conflict titles identify the problem and set without internal IDs', () => {
  assert.equal(recordConflictTitle(conflict, rows), '回答・復習の状態：化学の基礎 / 酸素の元素記号は？');
  const log = { ...conflict, local: { raw: JSON.stringify({ questionId: 'q_internal-id' }) }, remote: { ...conflict.remote, collection: 'answerLogs', id: 'log_internal-id' } };
  assert.equal(recordConflictTitle(log, rows), '回答履歴：化学の基礎 / 酸素の元素記号は？');
  assert.equal(recordConflictTitle(conflict, new Map()), '回答・復習の状態');
});

test('equal counters with different review flags remain distinguishable', () => {
  const progress = { answeredCount: 1, correctCount: 1, wrongCount: 0, isReview: true, reviewLevel: 1, lastAnswerCorrect: true };
  const ordinary = describeRecordConflictValue(JSON.stringify(progress));
  const ambiguous = describeRecordConflictValue(JSON.stringify({ ...progress, isAmbiguous: true }));
  const graduated = describeRecordConflictValue(JSON.stringify({ ...progress, isGraduated: true }));
  assert.match(ordinary, /回答 1回・正解 1回・不正解 0回/u);
  assert.match(ambiguous, /あやふや/u); assert.match(graduated, /卒業/u);
  assert.notEqual(ordinary, ambiguous); assert.notEqual(ordinary, graduated);
});

test('question explanations and deletions remain visible when their prompt is identical', () => {
  const question = { question: '同じ問題文', explanation: '端末で直した解説' };
  assert.match(describeRecordConflictValue(JSON.stringify(question)), /端末で直した解説/u);
  assert.notEqual(describeRecordConflictValue(JSON.stringify(question)), describeRecordConflictValue(JSON.stringify({ ...question, explanation: 'クラウドで直した解説' })));
  assert.equal(describeRecordConflictValue(null), '削除');
});

test('a chosen version is retained only while the operation, remote revision and contents remain identical', () => {
  const previous = new Map([[conflict.key, recordConflictIdentity(conflict)]]);
  const choices = { [conflict.key]: 'local' };
  assert.deepEqual(retainRecordConflictChoices(previous, [conflict], choices), choices);
  for (const changed of [{ ...conflict, operationId: 'new-operation' },
    { ...conflict, connection: { project: 'another-project', userId: 'another-user', syncId: 'another-sync' } },
    { ...conflict, remote: { ...conflict.remote, revision: 3 } },
    { ...conflict, local: { ...conflict.local, raw: '{"answeredCount":2}' } }]) {
    assert.deepEqual(retainRecordConflictChoices(previous, [changed], choices), {});
  }
  assert.deepEqual(retainRecordConflictChoices(previous, [], choices), {});
});
