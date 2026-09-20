import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const extensionHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const extensionlessRelativeImport = /^\.\.?\//u.test(specifier)
      && !/\.[cm]?[jt]sx?$/u.test(specifier)
      && context.parentURL?.endsWith('.ts');
    return nextResolve(extensionlessRelativeImport ? `${specifier}.ts` : specifier, context);
  },
});

const { buildAppDataView, sortQuestionOverviews } = await import('../src/utils/appDataView.ts');
const { getDailyAnswerCounts, getStudySummary, getRecommendedReviewQuestions } = await import('../src/utils/studyRecord.ts');
extensionHook.deregister();

test('study days use local dates, count repeated answers, and span month/year boundaries', () => {
  const local = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).toISOString();
  const counts = getDailyAnswerCounts([
    ...[29, 30, 31].map((day) => ({ answeredAt: local(2025, 12, day) })),
    { answeredAt: local(2026, 1, 1, 0) }, { answeredAt: local(2026, 1, 1, 23) }, { answeredAt: 'invalid' },
  ]);
  const summary = getStudySummary(counts, new Date(2026, 0, 1, 12));
  assert.equal(summary.todayCount, 2);
  assert.equal(summary.streak, 4);
  assert.deepEqual(summary.days.map((day) => day.count), [0, 0, 0, 1, 1, 1, 2]);
  assert.equal(summary.monthOffset, 3); // Thursday, Monday-first.
  assert.equal(summary.calendar.length, 31);
  assert.equal(summary.calendar[0].isToday, true);
  assert.equal(getStudySummary(counts, new Date(2026, 0, 2)).streak, 4);
  assert.equal(getStudySummary(counts, new Date(2026, 0, 3)).streak, 0);
  assert.equal(getStudySummary(new Map(), new Date(2024, 1, 29)).calendar.length, 29);
  assert.equal(getStudySummary(new Map()).todayCount, 0);
});

test('recommendations preserve review semantics, prioritize uncertainty, and never pad with future work', () => {
  const now = new Date(2026, 8, 21, 12);
  const progress = (id, daysAgo, overrides = {}) => createProgress(id, {
    isReview: true, lastAnswerCorrect: true, correctCount: 1, wrongCount: 0,
    lastAnsweredAt: new Date(2026, 8, 21 - daysAgo, 23).toISOString(), ...overrides,
  });
  const entries = [
    progress('future', 0), progress('today-l2', 3, { reviewLevel: 2 }),
    progress('overdue', 9, { reviewLevel: 3 }), progress('wrong', 0, { lastAnswerCorrect: false }),
    progress('ambiguous', 0, { isAmbiguous: true }), progress('graduated', 20, { isGraduated: true }),
    progress('not-review', 20, { isReview: false }), progress('invalid', 1, { lastAnsweredAt: 'invalid' }),
    progress('orphan', 20), progress('unanswered', 20, { answeredCount: 0 }),
  ];
  const data = { problemSets: [{ id: 'set' }], questions: entries.filter((p) => p.questionId !== 'orphan').map((p) => createQuestion(p.questionId, 'set')), progress: entries };
  const before = JSON.stringify(data);
  const selected = getRecommendedReviewQuestions(data, now);
  assert.deepEqual(selected.questions.map((q) => q.id), ['ambiguous', 'wrong', 'overdue', 'today-l2']);
  assert.equal(selected.needsCheckCount, 2);
  assert.equal(selected.dueCount, 2);
  assert.equal(JSON.stringify(data), before);
  assert.equal(getRecommendedReviewQuestions({ ...data, progress: [] }, now).questions.length, 0);
});

test('recommendations include all eligible questions, break ties by lateness then accuracy, and support multiple sets', () => {
  const entries = Array.from({ length: 12 }, (_, i) => createProgress(`q${i}`, {
    isReview: true, lastAnswerCorrect: true, answeredCount: 10, correctCount: i < 10 ? i : 5,
    wrongCount: i < 10 ? 10 - i : 5, lastAnsweredAt: new Date(2026, 8, i === 11 ? 1 : 2).toISOString(),
  }));
  const data = { problemSets: [{ id: 'a' }, { id: 'b' }], questions: entries.map((p, i) => createQuestion(p.questionId, i % 2 ? 'a' : 'b')), progress: entries };
  const result = getRecommendedReviewQuestions(data, new Date(2026, 8, 21));
  assert.equal(result.questions.length, 12);
  assert.equal(result.questions[0].id, 'q11');
  assert.equal(result.questions[1].id, 'q0');
  assert.equal(result.dueCount + result.needsCheckCount, 12);
});

const timestamp = '2026-08-15T00:00:00.000Z';

function createQuestion(id, setId) {
  return {
    id,
    setId,
    question: id,
    choices: ['1', '2', '3', '4'],
    answerIndex: 0,
    answerText: '1',
    explanation: '',
    sourcePage: '',
    category: '',
    difficulty: 'standard',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createProgress(questionId, overrides = {}) {
  return {
    questionId,
    answeredCount: 1,
    correctCount: 0,
    wrongCount: 1,
    lastSelectedIndex: 1,
    lastAnswerCorrect: false,
    lastAnsweredAt: timestamp,
    isReview: false,
    isAmbiguous: false,
    reviewLevel: 1,
    isGraduated: false,
    ...overrides,
  };
}

test('empty app data produces an empty, safe view model', () => {
  const view = buildAppDataView({
    version: 1,
    folders: [],
    problemSets: [],
    questions: [],
    progress: [],
    answerLogs: [],
  });

  assert.deepEqual(view.folders, []);
  assert.equal(view.folderById.size, 0);
  assert.equal(view.problemSetById.size, 0);
  assert.equal(view.problemSetsByFolderId.size, 0);
  assert.equal(view.questionsBySetId.size, 0);
});

test('missing references are excluded while legacy logs use canonical relationships', () => {
  const folder = { id: 'folder-1', name: '英語', createdAt: timestamp, updatedAt: timestamp };
  const validSet = { id: 'set-1', folderId: folder.id, title: '単語', source: '', createdAt: timestamp, updatedAt: timestamp };
  const detachedSet = { id: 'set-detached', folderId: 'missing-folder', title: 'Detached', source: '', createdAt: timestamp, updatedAt: timestamp };
  const firstQuestion = createQuestion('question-1', validSet.id);
  const secondQuestion = createQuestion('question-2', validSet.id);

  const view = buildAppDataView({
    version: 1,
    folders: [folder],
    problemSets: [validSet, detachedSet],
    questions: [
      firstQuestion,
      secondQuestion,
      createQuestion('question-detached', detachedSet.id),
      createQuestion('question-orphan', 'missing-set'),
    ],
    progress: [
      // Older data could mark ambiguity without also setting isReview.
      createProgress(firstQuestion.id, { isReview: false, isAmbiguous: true }),
      createProgress('question-orphan', { isReview: true }),
    ],
    answerLogs: [
      { id: 'log-1', questionId: firstQuestion.id, setId: 'stale-set', folderId: 'stale-folder', selectedIndex: 0, isCorrect: true, answeredAt: timestamp },
      { id: 'log-2', questionId: firstQuestion.id, setId: validSet.id, folderId: folder.id, selectedIndex: 1, isCorrect: false, answeredAt: timestamp },
      { id: 'log-3', questionId: secondQuestion.id, setId: validSet.id, folderId: folder.id, selectedIndex: 0, isCorrect: true, answeredAt: timestamp },
      { id: 'log-orphan', questionId: 'missing-question', setId: validSet.id, folderId: folder.id, selectedIndex: 0, isCorrect: true, answeredAt: timestamp },
    ],
  });

  assert.deepEqual(view.folders.map(({ folder: item, ...summary }) => ({ id: item.id, ...summary })), [{
    id: folder.id,
    setCount: 1,
    questionCount: 2,
    reviewCount: 1,
    correctRate: 67,
  }]);

  const setItems = view.problemSetsByFolderId.get(folder.id);
  assert.equal(setItems?.length, 1);
  assert.deepEqual(setItems?.[0], {
    problemSet: validSet,
    questionCount: 2,
    reviewCount: 1,
    correctRate: 67,
  });

  const questionItems = view.questionsBySetId.get(validSet.id);
  assert.deepEqual(questionItems?.map((item) => item.number), [1, 2]);
  assert.equal(questionItems?.[0].progress.isAmbiguous, true);
  assert.deepEqual(questionItems?.[1].progress, {
    questionId: secondQuestion.id,
    answeredCount: 0,
    correctCount: 0,
    wrongCount: 0,
    lastSelectedIndex: null,
    lastAnswerCorrect: null,
    lastAnsweredAt: null,
    isReview: false,
    isAmbiguous: false,
    reviewLevel: null,
    isGraduated: false,
  });
  assert.equal(view.questionsBySetId.has('missing-set'), false);
});

test('large data is summarized once without changing collection order or counts', () => {
  const folderCount = 25;
  const setsPerFolder = 20;
  const questionsPerSet = 40;
  const folders = [];
  const problemSets = [];
  const questions = [];
  const progress = [];
  const answerLogs = [];

  for (let folderIndex = 0; folderIndex < folderCount; folderIndex += 1) {
    const folderId = `folder-${folderIndex}`;
    folders.push({ id: folderId, name: folderId, createdAt: timestamp, updatedAt: timestamp });
    for (let setIndex = 0; setIndex < setsPerFolder; setIndex += 1) {
      const setId = `set-${folderIndex}-${setIndex}`;
      problemSets.push({ id: setId, folderId, title: setId, source: '', createdAt: timestamp, updatedAt: timestamp });
      for (let questionIndex = 0; questionIndex < questionsPerSet; questionIndex += 1) {
        const questionId = `question-${folderIndex}-${setIndex}-${questionIndex}`;
        questions.push(createQuestion(questionId, setId));
        progress.push(createProgress(questionId, {
          isReview: questionIndex % 2 === 0,
          reviewLevel: (questionIndex % 3) + 1,
        }));
        answerLogs.push({
          id: `log-${questionId}`,
          questionId,
          setId,
          folderId,
          selectedIndex: 0,
          isCorrect: questionIndex % 4 === 0,
          answeredAt: timestamp,
        });
      }
    }
  }

  const view = buildAppDataView({ version: 1, folders, problemSets, questions, progress, answerLogs });
  const lastFolder = view.folders.at(-1);
  assert.equal(view.folders.length, folderCount);
  assert.equal(lastFolder?.folder.id, `folder-${folderCount - 1}`);
  assert.deepEqual(lastFolder && {
    setCount: lastFolder.setCount,
    questionCount: lastFolder.questionCount,
    reviewCount: lastFolder.reviewCount,
    correctRate: lastFolder.correctRate,
  }, {
    setCount: setsPerFolder,
    questionCount: setsPerFolder * questionsPerSet,
    reviewCount: setsPerFolder * questionsPerSet / 2,
    correctRate: 25,
  });

  const lastSetId = `set-${folderCount - 1}-${setsPerFolder - 1}`;
  const lastSet = view.problemSetsByFolderId.get(`folder-${folderCount - 1}`)?.at(-1);
  assert.equal(lastSet?.problemSet.id, lastSetId);
  assert.equal(lastSet?.questionCount, questionsPerSet);
  assert.equal(lastSet?.reviewCount, questionsPerSet / 2);
  assert.equal(lastSet?.correctRate, 25);
  assert.equal(view.questionsBySetId.get(lastSetId)?.at(-1)?.number, questionsPerSet);
});

test('problem-list level sorting uses indexed progress and remains stable within a level', () => {
  const questions = [
    { question: createQuestion('graduated', 'set'), number: 1, progress: createProgress('graduated', { isGraduated: true }) },
    { question: createQuestion('level-1-a', 'set'), number: 2, progress: createProgress('level-1-a', { reviewLevel: 1 }) },
    { question: createQuestion('ambiguous', 'set'), number: 3, progress: createProgress('ambiguous', { isAmbiguous: true }) },
    { question: createQuestion('unanswered', 'set'), number: 4, progress: createProgress('unanswered', { answeredCount: 0, reviewLevel: null }) },
    { question: createQuestion('level-1-b', 'set'), number: 5, progress: createProgress('level-1-b', { reviewLevel: 1 }) },
    { question: createQuestion('level-3', 'set'), number: 6, progress: createProgress('level-3', { reviewLevel: 3 }) },
  ];

  assert.deepEqual(
    sortQuestionOverviews(questions, 'ordered').map((item) => item.question.id),
    questions.map((item) => item.question.id),
  );
  assert.deepEqual(
    sortQuestionOverviews(questions, 'level').map((item) => item.question.id),
    ['ambiguous', 'unanswered', 'level-1-a', 'level-1-b', 'level-3', 'graduated'],
  );
});
