import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
const { normalizeAppData } = await import('../src/utils/appDataValidation.ts');
const { canMoveFolder, moveFolder, moveProblemSet } = await import('../src/utils/folderHierarchy.ts');
const { addFolder, deleteFolder } = await import('../src/utils/quiz.ts');
const { buildAppDataView } = await import('../src/utils/appDataView.ts');
hook.deregister();
const date = '2026-09-07T00:00:00.000Z';
function fixture() {
  return { version: 1, folders: [{ id: 'a', name: 'A', createdAt: date, updatedAt: date }, { id: 'b', name: 'B', parentFolderId: 'a', createdAt: date, updatedAt: date }, { id: 'c', name: 'C', createdAt: date, updatedAt: date }],
    problemSets: [{ id: 's', folderId: 'b', title: 'S', source: 'hidden source', subject: 'subject', createdAt: date, updatedAt: date }],
    questions: [{ id: 'q', setId: 's', question: 'Q', choices: ['a', 'b', 'c', 'd'], answerIndex: 0, explanation: '', detailedExplanation: 'legacy', sourcePage: 'page', category: '', difficulty: 'basic', createdAt: date, updatedAt: date }],
    progress: [], answerLogs: [{ id: 'log', questionId: 'q', setId: 's', folderId: 'b', selectedIndex: 0, isCorrect: true, answeredAt: date }] };
}
test('legacy data and new optional content survive normalization and JSON round trips', () => {
  const data = fixture();
  data.questions[0].detailedAnswer = { body: 'new', imageIds: ['image'], updatedAt: date };
  data.questions[0].questionImageIds = ['question-image'];
  const normalized = normalizeAppData(JSON.parse(JSON.stringify(data)));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.data.folders[0].parentFolderId, undefined);
  assert.equal(normalized.data.folders[1].parentFolderId, 'a');
  assert.deepEqual(normalized.data.questions[0].detailedAnswer, data.questions[0].detailedAnswer);
  assert.equal(normalized.data.questions[0].detailedExplanation, 'legacy');
  assert.equal(normalized.data.problemSets[0].source, 'hidden source');
  assert.deepEqual(normalizeAppData(normalized.data), normalized);
});
test('invalid references and cycles are detached without dropping folders', () => {
  for (const parents of [['b','a'], ['missing','a'], ['a','b']]) {
    const data = fixture(); data.folders[0].parentFolderId = parents[0]; data.folders[1].parentFolderId = parents[1];
    const result = normalizeAppData(data);
    assert.equal(result.ok, true);
    assert.equal(result.data.folders.length, 3);
    for (const folder of result.data.folders) {
      if (folder.parentFolderId) assert.equal(result.data.folders.find((f) => f.id === folder.parentFolderId)?.parentFolderId, undefined);
    }
  }
});
test('folder moves reject grandchildren and self targets; child can move or become root', () => {
  const data = fixture();
  assert.equal(canMoveFolder(data.folders, 'a', 'a'), false);
  assert.equal(canMoveFolder(data.folders, 'c', 'b'), false);
  assert.equal(canMoveFolder(data.folders, 'a', 'c'), false);
  assert.throws(() => addFolder(data, 'grandchild', 'b'));
  assert.equal(moveFolder(data, 'b', 'c').folders[1].parentFolderId, 'c');
  assert.equal(moveFolder(data, 'b').folders[1].parentFolderId, undefined);
});
test('parent counts include child content and moving a set repairs canonical log ids', () => {
  const data = fixture();
  const parent = buildAppDataView(data).folders[0];
  assert.equal(parent.setCount, 1); assert.equal(parent.questionCount, 1); assert.equal(parent.correctRate, 100);
  data.answerLogs[0].setId = 'old';
  const moved = moveProblemSet(data, 's', 'c');
  assert.equal(moved.answerLogs[0].folderId, 'c'); assert.equal(moved.answerLogs[0].setId, 's');
  assert.equal(data.problemSets[0].folderId, 'b');
});
test('parent deletion leaves no descendant content or logs', () => {
  const result = deleteFolder(fixture(), 'a');
  assert.deepEqual(result.folders.map((f) => f.id), ['c']);
  for (const field of ['problemSets', 'questions', 'progress', 'answerLogs']) assert.equal(result[field].length, 0);
});
