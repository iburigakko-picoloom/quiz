import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getScreenKey } from '../src/utils/navigation.ts';

test('direct AI creation and the creation menu have separate navigation identities',()=>{
  assert.notEqual(getScreenKey({name:'createProblemSet'}),getScreenKey({name:'createProblemSet',backScreen:{name:'home'}}));
});
import {
  getBackNavigationSteps,
  getCreateProblemSetBackScreen,
  getResultReturnLabel,
  getResultReturnScreen,
} from '../src/utils/navigation.ts';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('jumping home unwinds every pushed screen instead of leaving dead history entries', () => {
  const stack = [
    { name: 'home' },
    { name: 'folder', folderId: 'folder-1' },
    { name: 'problemSetDetail', setId: 'set-1' },
    {
      name: 'quizSession',
      session: {
        title: 'Quiz',
        questions: [],
        mode: 'quiz',
        backScreen: { name: 'problemSetDetail', setId: 'set-1' },
      },
    },
    {
      name: 'result',
      result: {
        mode: 'quiz',
        title: 'Quiz',
        answered: 1,
        correct: 1,
        wrong: 0,
        addedReviewCount: 0,
      },
    },
  ];

  assert.equal(getBackNavigationSteps(stack, { name: 'home' }), 4);
  assert.equal(getBackNavigationSteps(stack, { name: 'problemSetDetail', setId: 'set-1' }), 2);
});

test('unknown back targets use a single browser-history step', () => {
  assert.equal(
    getBackNavigationSteps([{ name: 'home' }, { name: 'sync' }], { name: 'folder', folderId: 'missing' }),
    1,
  );
});

test('problem-set creation returns to the screen that opened it', () => {
  assert.deepEqual(
    getCreateProblemSetBackScreen({
      name: 'createProblemSet',
      folderId: 'folder-1',
      backScreen: { name: 'settings' },
    }),
    { name: 'settings' },
  );
  assert.deepEqual(
    getCreateProblemSetBackScreen({ name: 'createProblemSet', folderId: 'folder-1' }),
    { name: 'folder', folderId: 'folder-1' },
  );
  assert.deepEqual(
    getCreateProblemSetBackScreen({ name: 'createProblemSet', editSetId: 'set-1' }),
    { name: 'problemSetDetail', setId: 'set-1' },
  );
  assert.deepEqual(
    getCreateProblemSetBackScreen({ name: 'createProblemSet' }),
    null,
  );
});

test('result exits return to the session origin and reject deleted local targets', () => {
  const data = {
    version: 1,
    folders: [{ id: 'folder-1', name: '英語', createdAt: '', updatedAt: '' }],
    problemSets: [{ id: 'set-1', folderId: 'folder-1', title: '単語', source: '', createdAt: '', updatedAt: '' }],
    questions: [],
    progress: [],
    answerLogs: [],
  };
  const baseResult = { mode: 'quiz', title: '単語', answered: 1, correct: 1, wrong: 0, addedReviewCount: 0 };

  const detailTarget = getResultReturnScreen({
    ...baseResult,
    returnScreen: { name: 'problemSetDetail', setId: 'set-1' },
  }, data);
  assert.deepEqual(detailTarget, { name: 'problemSetDetail', setId: 'set-1' });
  assert.equal(getResultReturnLabel(detailTarget), '問題セットへ戻る');

  const listTarget = getResultReturnScreen({
    ...baseResult,
    returnScreen: { name: 'problemList', setId: 'set-1', sortMode: 'level' },
  }, data);
  assert.equal(getResultReturnLabel(listTarget), '問題一覧へ戻る');

  const sharedTarget = getResultReturnScreen({
    ...baseResult,
    returnScreen: { name: 'community', tab: 'discover', shareSetId: 'shared-1' },
  }, data);
  assert.deepEqual(sharedTarget, { name: 'community', tab: 'discover', shareSetId: 'shared-1' });
  assert.equal(getResultReturnLabel(sharedTarget), '共有詳細へ戻る');

  assert.deepEqual(getResultReturnScreen({
    ...baseResult,
    returnScreen: { name: 'problemSetDetail', setId: 'deleted' },
  }, data), { name: 'home' });
});

test('missing local routes render an explanation and a safe recovery action', () => {
  for (const path of [
    '../src/screens/FolderScreen.tsx',
    '../src/screens/ProblemSetDetailScreen.tsx',
    '../src/screens/ProblemListScreen.tsx',
    '../src/screens/NoteListScreen.tsx',
  ]) {
    assert.match(readSource(path), /MissingResourceState/);
  }
  assert.match(readSource('../src/screens/QuizScreen.tsx'), /emptyState=\{!problemSet/);
  assert.match(readSource('../src/screens/QuizRunner.tsx'), /emptyState\?\.title/);
  assert.match(readSource('../src/App.tsx'), /problemSet \? \(\) => goBackTo\(\{ name: 'problemSetDetail'/);
});
