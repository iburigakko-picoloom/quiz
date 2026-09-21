import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getScreenKey } from '../src/utils/navigation.ts';
import { dismissCloudUpdate, isCloudUpdateDismissed } from '../src/utils/cloudUpdateNotice.ts';

test('cloud notice dismissal applies only to the same connection and revision', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  try {
    const notice = { syncId: 'notice-test', updatedAt: '2026-09-21T00:00:00Z' };
    assert.equal(isCloudUpdateDismissed(notice), false);
    dismissCloudUpdate(notice);
    assert.equal(isCloudUpdateDismissed(notice), true);
    assert.equal(values.get('quiz-make-cloud-notice-dismissed:notice-test'), notice.updatedAt);
    assert.equal(isCloudUpdateDismissed({ ...notice, updatedAt: '2026-09-22T00:00:00Z' }), false);
    assert.equal(isCloudUpdateDismissed({ ...notice, syncId: 'another-connection' }), false);
    values.set('quiz-make-cloud-notice-dismissed:stored-connection', notice.updatedAt);
    assert.equal(isCloudUpdateDismissed({ ...notice, syncId: 'stored-connection' }), true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('direct AI creation and the creation menu have separate navigation identities',()=>{
  assert.notEqual(getScreenKey({name:'createProblemSet'}),getScreenKey({name:'createProblemSet',backScreen:{name:'home'}}));
  const backScreen = {name:'noteList',setId:'set-1'};
  const importer = {name:'createProblemSet',importExplanations:true,backScreen};
  assert.notEqual(getScreenKey(importer),getScreenKey({name:'createProblemSet',backScreen}));
  assert.deepEqual(getCreateProblemSetBackScreen(importer),backScreen);
});
import {
  getBackNavigationSteps,
  getCommunityBackScreen,
  getCreateProblemSetBackScreen,
  getResultReturnLabel,
  getResultReturnScreen,
} from '../src/utils/navigation.ts';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('recommended review returns to study records after a session or result', () => {
  const target = { name: 'studyRecord' };
  const result = { mode: 'review', title: '今日のおすすめ', returnScreen: target };
  assert.deepEqual(getResultReturnScreen(result, { folders: [], problemSets: [] }), target);
  assert.equal(getResultReturnLabel(target), '学習記録へ戻る');
  assert.equal(getBackNavigationSteps([{ name: 'home' }, target, { name: 'quizSession', session: { questions: [], mode: 'review', backScreen: target } }], target), 1);
});

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

  const source = { name: 'problemSetDetail', setId: 'set-1', backScreen: { name: 'folder', folderId: 'folder-1' } };
  const edit = { name: 'createProblemSet', editSetId: 'set-1', backScreen: source };
  assert.deepEqual(getCreateProblemSetBackScreen(edit), source);
  assert.equal(getBackNavigationSteps([{ name: 'home' }, source.backScreen, source, edit], source), 1);
  const save = readSource('../src/App.tsx').split('const handleUpdateProblemSet =')[1].split('const handleCopySharedProblemSet =')[0];
  assert.match(save, /createDraftDirtyRef\.current = false;\s*performBackNavigation\(screenRef\.current\.backScreen/);
  assert.doesNotMatch(save, /replaceScreen\(/);
});

test('sharing returns to its origin without exposing the management list', () => {
  const origin = { name: 'problemSetDetail', setId: 'set-1', backScreen: { name: 'folder', folderId: 'folder-1' } };
  assert.deepEqual(getCommunityBackScreen({ name: 'community', tab: 'mine', shareSetId: 'set-1', backScreen: origin }), origin);
  assert.deepEqual(getCommunityBackScreen({ name: 'community', tab: 'mine', shareSetId: 'set-1' }), { name: 'problemSetDetail', setId: 'set-1' });
  assert.deepEqual(getCommunityBackScreen({ name: 'community', tab: 'groups', groupId: 'group-1' }), { name: 'community', tab: 'groups' });
  assert.deepEqual(getCommunityBackScreen({ name: 'community', tab: 'discover', shareSetId: 'cloud-1', shareToken: 'token' }), { name: 'home' });
  const source = readSource('../src/screens/CommunityScreen.tsx');
  assert.match(source, /if \(isDirectShare\) onBack\(\)/);
  assert.match(source, /onClose=\{closeShare\}/);
  assert.match(source, /onClose=\{closeLogin\}/);
  assert.match(source, /tab === 'mine' && !isDirectShare/);
  assert.match(source, /onClick=\{onManageShares\}/);
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
