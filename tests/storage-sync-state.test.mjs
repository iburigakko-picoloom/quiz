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

process.on('exit', () => extensionHook.deregister());

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key) {
    return this.#values.get(String(key)) ?? null;
  }

  key(index) {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

const storage = await import('../src/storage.ts');
const notes = await import('../src/utils/noteStorage.ts');
const syncState = await import('../src/utils/syncState.ts');
const coordination = await import('../src/utils/dataCoordination.ts');
const backups = await import('../src/utils/backupRepository.ts');

test('backup listing contains only summaries; legacy and current backups remain restorable', async () => {
  delete globalThis.indexedDB;
  localStorage.clear();
  const payload = { version: 1, updatedAt: '2026-09-22', localStorage: { example: '日本語' }, indexedDbNotes: {} };
  const saved = await backups.saveBackupPayload(payload, 'manual');
  const legacy = { id: 'old-backup', createdAt: '2020-01-01', kind: 'before-sync', raw: JSON.stringify(payload) };
  localStorage.setItem('quizMake:sync:saved-backup:old-backup', JSON.stringify(legacy));
  const list = await backups.listSavedBackups();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, saved.id);
  for (const row of list) {
    assert.equal('raw' in row, false, 'list state must not retain backup bodies');
    assert.equal(row.byteSize, new Blob([JSON.stringify(payload)]).size);
    assert.deepEqual(JSON.parse((await backups.getSavedBackup(row.id)).raw), payload);
  }
  assert.equal(localStorage.getItem('quizMake:sync:saved-backup:old-backup'), JSON.stringify(legacy), 'reading summaries never rewrites older backups');
  await backups.deleteSavedBackup(saved.id);
  assert.equal((await backups.listSavedBackups()).length, 1);
});

test('IndexedDB backup listing reads one record at a time and closes its read-only transaction', async () => {
  const previous = globalThis.indexedDB;
  localStorage.clear();
  const rows = [0, 1, 2].map(index => ({ id: String(index), createdAt: `2026-09-${20+index}`, kind: 'manual', raw: 'x'.repeat(1000), byteSize: 1000 }));
  let closed = false; let reads = 0;
  globalThis.indexedDB = { open() {
    const opening = {};
    opening.result = { close() { closed = true; }, transaction(_name, mode) {
      assert.equal(mode, 'readonly');
      const transaction = { objectStore() { return { openCursor() {
        const request = {}; let index = 0;
        const next = () => queueMicrotask(() => {
          request.result = index < rows.length ? { value: rows[index++], continue: next } : null;
          if (request.result) reads++;
          request.onsuccess();
          if (!request.result) transaction.oncomplete();
        });
        next(); return request;
      } }; } };
      return transaction;
    } };
    queueMicrotask(() => opening.onsuccess()); return opening;
  } };
  try {
    const summaries = await backups.listSavedBackups();
    assert.equal(reads, 3);
    assert.equal(closed, true);
    assert.deepEqual(summaries.map(row => row.id), ['2','1','0']);
    assert.ok(summaries.every(row => !('raw' in row) && row.byteSize === 1000));
  } finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});

function resetStorage() {
  localStorage.clear();
  coordination.resetDataCoordinationForTests();
}

test('localStorage fallback saves payload and timestamp atomically', async () => {
  delete globalThis.indexedDB;
  resetStorage();
  const timestamp = '2026-07-29T00:00:00.000Z';
  const data = {
    ...storage.createEmptyAppData(),
    folders: [{
      id: 'folder-1',
      name: 'Saved folder',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  };

  assert.equal(await storage.saveAppData(data), true);
  assert.equal(localStorage.getItem(storage.APP_DATA_STORAGE_KEY), null);
  assert.equal(localStorage.getItem(storage.APP_DATA_FALLBACK_META_KEY), null);
  assert.ok(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .some((key) => key?.endsWith(':fallback-record')));
  assert.deepEqual(await storage.loadAppDataAsync(), data);
});

test('changing sync id clears timestamps and hashes from the previous id', () => {
  resetStorage();
  const firstId = '111111111111111111111111111111111111';
  const secondId = '222222222222222222222222222222222222';
  localStorage.setItem(syncState.LAST_SYNC_AT_KEY, '2026-07-29T00:00:00.000Z');
  localStorage.setItem(syncState.LAST_UPLOAD_HASH_KEY, 'old-hash');
  localStorage.setItem(syncState.LAST_REMOTE_UPDATED_AT_KEY, '2026-07-29T00:00:01.000Z');
  localStorage.setItem(syncState.LAST_SYNC_STATUS_KEY, 'saved');
  localStorage.setItem(syncState.LAST_SYNC_ERROR_KEY, 'old-error');
  localStorage.setItem(syncState.LAST_SYNC_RECORD_KEY, JSON.stringify({ owner: firstId, state: {} }));

  assert.equal(syncState.clearSyncStateForChangedId(localStorage, firstId, firstId), false);
  assert.equal(localStorage.getItem(syncState.LAST_UPLOAD_HASH_KEY), 'old-hash');
  assert.equal(syncState.clearSyncStateForChangedId(localStorage, firstId, secondId), true);
  assert.equal(localStorage.getItem(syncState.LAST_SYNC_AT_KEY), null);
  assert.equal(localStorage.getItem(syncState.LAST_UPLOAD_HASH_KEY), null);
  assert.equal(localStorage.getItem(syncState.LAST_REMOTE_UPDATED_AT_KEY), null);
  assert.equal(localStorage.getItem(syncState.LAST_SYNC_STATUS_KEY), null);
  assert.equal(localStorage.getItem(syncState.LAST_SYNC_ERROR_KEY), null);
  assert.equal(localStorage.getItem(syncState.LAST_SYNC_RECORD_KEY), null);
});

test('sync ids must use the generated 144-bit hexadecimal format', () => {
  assert.equal(syncState.isStrongSyncId('1234'), false);
  assert.equal(syncState.isStrongSyncId('111111111111111111111111111111111111'), true);
  assert.equal(syncState.isStrongSyncId('11111111-1111-1111-1111-111111111111'), false);
});

test('note reconciliation keeps the newest valid fallback value', () => {
  const older = JSON.stringify({ dataUrl: 'old', updatedAt: '2026-07-29T00:00:00.000Z' });
  const newer = JSON.stringify({ dataUrl: 'new', updatedAt: '2026-07-29T00:00:02.000Z' });

  assert.equal(notes.pickNewestNoteRaw([older, null, newer]), newer);
});

test('problem-set note matching requires an exact id boundary', () => {
  assert.equal(notes.isCategoryNoteKeyForProblemSetIds('quizMake:notes:set-1:vocabulary', ['set-1']), true);
  assert.equal(notes.isCategoryNoteKeyForProblemSetIds('quizMake:notes:set-10:vocabulary', ['set-1']), false);
  assert.equal(notes.isCategoryNoteKeyForProblemSetIds('quizMake:notes:set-1:vocabulary', []), false);
  assert.equal(notes.isCategoryNoteKeyForProblemSetIds('quizMake:other:set-1:vocabulary', ['set-1']), false);
});

test('note loading keeps a valid legacy fallback but never treats an IndexedDB failure as empty', async () => {
  const key = 'quizMake:notes:set-1:vocabulary';
  const raw = JSON.stringify({
    problemSetId: 'set-1',
    category: 'vocabulary',
    pages: [{ id: 'page-1', dataUrl: 'data:image/png;base64,old-note', updatedAt: '2026-08-15T00:00:00.000Z' }],
    currentPageIndex: 0,
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.indexedDB = {
    open() {
      const error = new Error('note database is temporarily unavailable');
      const request = { result: null, error, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };

  try {
    resetStorage();
    localStorage.setItem(key, raw);
    assert.equal(await notes.loadCategoryNoteRaw(key), raw, 'the durable fallback remains readable');
    assert.equal(localStorage.getItem(key), raw, 'a failed primary read must not consume the fallback');

    resetStorage();
    await assert.rejects(
      notes.loadCategoryNoteRaw(key),
      /Failed to read category note data/,
      'an unreadable current store is not an empty note',
    );
  } finally {
    console.warn = originalWarn;
    delete globalThis.indexedDB;
    resetStorage();
  }
});

test('bulk exports fail closed when IndexedDB cannot be read', async () => {
  resetStorage();
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.indexedDB = {
    open() {
      const error = new Error('database read is temporarily unavailable');
      const request = { result: null, error, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };

  try {
    await assert.rejects(
      storage.exportAppDataRaw(),
      /空のバックアップで上書きしない/,
    );
    await assert.rejects(
      notes.exportCategoryNotesRaw(),
      /空のバックアップで上書きしない/,
    );
  } finally {
    console.warn = originalWarn;
    delete globalThis.indexedDB;
    resetStorage();
  }
});

test('invalid stored note data is surfaced instead of becoming an editable blank note', async () => {
  const key = 'quizMake:notes:set-1:vocabulary';
  delete globalThis.indexedDB;
  resetStorage();
  localStorage.setItem(key, '{broken');

  try {
    await assert.rejects(notes.loadCategoryNoteRaw(key), /Stored category note data is invalid/);
  } finally {
    resetStorage();
  }
});

test('a timed-out note storage operation releases the caller for a later retry', async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    notes.waitForCategoryNoteStorage(neverSettles, 5),
    (error) => error instanceof notes.CategoryNoteStorageTimeoutError,
  );
  assert.equal(await notes.waitForCategoryNoteStorage(Promise.resolve('saved'), 5), 'saved');
});

test('problem-set note deletion removes only matching local fallback notes', async () => {
  delete globalThis.indexedDB;
  resetStorage();
  localStorage.setItem('quizMake:notes:set-1:vocabulary', 'first');
  localStorage.setItem('quizMake:notes:set-1:grammar', 'second');
  localStorage.setItem('quizMake:notes:set-10:vocabulary', 'keep-prefix-neighbor');
  localStorage.setItem('quizMake:notes:set-2:vocabulary', 'keep-other-set');
  localStorage.setItem('quizMake:settings', 'keep-unrelated');

  assert.equal(await notes.deleteCategoryNotesForProblemSetIds(['set-1']), 2);
  assert.equal(localStorage.getItem('quizMake:notes:set-1:vocabulary'), null);
  assert.equal(localStorage.getItem('quizMake:notes:set-1:grammar'), null);
  assert.equal(localStorage.getItem('quizMake:notes:set-10:vocabulary'), 'keep-prefix-neighbor');
  assert.equal(localStorage.getItem('quizMake:notes:set-2:vocabulary'), 'keep-other-set');
  assert.equal(localStorage.getItem('quizMake:settings'), 'keep-unrelated');
});

test('all-note deletion preserves non-note local storage entries', async () => {
  delete globalThis.indexedDB;
  resetStorage();
  localStorage.setItem('quizMake:notes:set-1:vocabulary', 'first');
  localStorage.setItem('quizMake:notes:set-2:grammar', 'second');
  localStorage.setItem('quizMake:settings', 'keep-unrelated');

  assert.equal(await notes.deleteAllCategoryNotes(), 2);
  assert.equal(localStorage.getItem('quizMake:notes:set-1:vocabulary'), null);
  assert.equal(localStorage.getItem('quizMake:notes:set-2:grammar'), null);
  assert.equal(localStorage.getItem('quizMake:settings'), 'keep-unrelated');
});

test('replacing IndexedDB notes clears current and backup stores atomically', async () => {
  resetStorage();
  const calls = [];
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    transaction(storeNames, mode) {
      calls.push(['transaction', [...storeNames], mode]);
      const transaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore(storeName) {
          return {
            clear() {
              calls.push(['clear', storeName]);
            },
            put() {},
          };
        },
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: fakeDb, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };

  try {
    assert.equal(await notes.replaceCategoryNotesRaw({}), 0);
    assert.deepEqual(calls, [
      ['transaction', ['categoryNotes', 'categoryNoteBackups'], 'readwrite'],
      ['clear', 'categoryNotes'],
      ['clear', 'categoryNoteBackups'],
    ]);
  } finally {
    delete globalThis.indexedDB;
  }
});

test('failed local note deletion restores entries removed earlier in the operation', async () => {
  delete globalThis.indexedDB;
  const failingStorage = new class extends MemoryStorage {
    removeItem(key) {
      if (String(key) === 'quizMake:notes:set-1:second') throw new Error('storage is unavailable');
      super.removeItem(key);
    }
  }();
  globalThis.localStorage = failingStorage;
  coordination.resetDataCoordinationForTests();
  failingStorage.setItem('quizMake:notes:set-1:first', 'first');
  failingStorage.setItem('quizMake:notes:set-1:second', 'second');

  try {
    await assert.rejects(
      notes.deleteCategoryNotesForProblemSetIds(['set-1']),
      /Failed to delete local category notes/,
    );
    assert.equal(failingStorage.getItem('quizMake:notes:set-1:first'), 'first');
    assert.equal(failingStorage.getItem('quizMake:notes:set-1:second'), 'second');
  } finally {
    globalThis.localStorage = new MemoryStorage();
    coordination.resetDataCoordinationForTests();
  }
});

function createLegacyQuestionData(overrides = {}) {
  return {
    version: 1,
    folders: [{ id: 'folder-1', name: '英語', createdAt: 'invalid', updatedAt: '2026-08-15' }],
    problemSets: [{
      id: 'set-1',
      folderId: 'folder-1',
      title: '単語',
      source: '',
      creationMethod: 'ai',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: 'invalid',
    }],
    questions: [{
      id: 'question-1',
      setId: 'set-1',
      question: 'meaning?',
      choices: ['a', 'b', 'c', 'd'],
      answerIndex: 3,
      answerIndexes: [3, 1, 3],
      explanation: '',
      createdAt: 'invalid',
      updatedAt: 'invalid',
    }],
    ...overrides,
  };
}

test('version 1 legacy data is normalized without rejecting missing derived state', () => {
  const result = storage.parseBackupJson(JSON.stringify(createLegacyQuestionData()));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.problemSets[0].creationMethod, 'chatgpt');
  assert.equal(result.data.problemSets[0].updatedAt, '2026-08-15T00:00:00.000Z');
  assert.equal(result.data.folders[0].createdAt, '2026-08-15T00:00:00.000Z');
  assert.deepEqual(result.data.questions[0].answerIndexes, [1, 3]);
  assert.equal(result.data.questions[0].answerIndex, 1);
  assert.equal(result.data.questions[0].answerText, 'b / d');
  assert.equal(result.data.questions[0].difficulty, 'standard');
  assert.deepEqual(result.data.progress, [{
    questionId: 'question-1',
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
  }]);
  assert.deepEqual(result.data.answerLogs, []);
});

test('derived progress and logs are repaired without changing content relationships', () => {
  const result = storage.parseBackupJson(JSON.stringify(createLegacyQuestionData({
    progress: [
      { questionId: 'missing-question', answeredCount: 10 },
      {
        questionId: 'question-1',
        answeredCount: 1,
        correctCount: 2,
        wrongCount: 1,
        lastSelectedIndex: 99,
        lastAnsweredAt: '2026-08-15',
        isReview: true,
        isAmbiguous: false,
        reviewLevel: 9,
        isGraduated: false,
      },
    ],
    answerLogs: [
      {
        id: 'log-1',
        questionId: 'question-1',
        setId: 'wrong-set',
        folderId: 'wrong-folder',
        selectedIndex: 3,
        isCorrect: true,
        answeredAt: '2026-08-15',
      },
      { id: 'orphan', questionId: 'missing-question', answeredAt: '2026-08-15' },
    ],
  })));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.progress.length, 1);
  assert.equal(result.data.progress[0].answeredCount, 3);
  assert.equal(result.data.progress[0].lastSelectedIndex, null);
  assert.equal(result.data.progress[0].reviewLevel, null);
  assert.deepEqual(result.data.answerLogs, [{
    id: 'log-1',
    questionId: 'question-1',
    setId: 'set-1',
    folderId: 'folder-1',
    selectedIndex: 3,
    selectedIndexes: [3],
    isCorrect: true,
    answeredAt: '2026-08-15T00:00:00.000Z',
  }]);
});

test('ambiguous content corruption is rejected instead of silently reconnecting records', () => {
  const duplicateFolder = createLegacyQuestionData();
  duplicateFolder.folders.push({ ...duplicateFolder.folders[0] });
  const duplicateResult = storage.parseBackupJson(JSON.stringify(duplicateFolder));
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.match(duplicateResult.error, /重複ID/);

  const brokenForeignKey = createLegacyQuestionData();
  brokenForeignKey.questions[0].setId = 'missing-set';
  const foreignKeyResult = storage.parseBackupJson(JSON.stringify(brokenForeignKey));
  assert.equal(foreignKeyResult.ok, false);
  if (!foreignKeyResult.ok) assert.match(foreignKeyResult.error, /存在しない問題セット/);

  const invalidAnswer = createLegacyQuestionData();
  invalidAnswer.questions[0].answerIndexes = [4];
  const answerResult = storage.parseBackupJson(JSON.stringify(invalidAnswer));
  assert.equal(answerResult.ok, false);
  if (!answerResult.ok) assert.match(answerResult.error, /範囲外/);

  const duplicateLog = createLegacyQuestionData({
    answerLogs: [
      { id: 'log-1', questionId: 'question-1', selectedIndex: 1, isCorrect: true, answeredAt: '2026-08-15' },
      { id: 'log-1', questionId: 'question-1', selectedIndex: 3, isCorrect: false, answeredAt: '2026-08-15' },
    ],
  });
  const duplicateLogResult = storage.parseBackupJson(JSON.stringify(duplicateLog));
  assert.equal(duplicateLogResult.ok, false);
  if (!duplicateLogResult.ok) assert.match(duplicateLogResult.error, /answerLogs.*重複ID/);
});

test('corrupted stored payload throws and is not replaced with empty data', async () => {
  delete globalThis.indexedDB;
  resetStorage();
  const corruptedRaw = '{"version":1,"folders":[';
  localStorage.setItem(storage.APP_DATA_STORAGE_KEY, corruptedRaw);

  await assert.rejects(storage.loadAppDataAsync(), /空のデータで上書き/);
  assert.equal(localStorage.getItem(storage.APP_DATA_STORAGE_KEY), corruptedRaw);
  await assert.rejects(storage.exportAppDataRaw(), /空のバックアップ/);
});
