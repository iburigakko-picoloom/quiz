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
  failReadsFor = new Set();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
    this.failReadsFor.clear();
  }

  getItem(key) {
    const normalizedKey = String(key);
    if (this.failReadsFor.has(normalizedKey)) throw new Error('storage read failed');
    return this.#values.get(normalizedKey) ?? null;
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

function createIndexedDbHarness() {
  const databases = new Map();

  function ensureDatabase(name) {
    if (!databases.has(name)) {
      const initialStores = name === 'quiz-make-app-data-v1'
        ? ['appData', 'appDataBackups']
        : name === 'quiz-make-notes-v1'
          ? ['categoryNotes', 'categoryNoteBackups']
          : [];
      databases.set(name, new Map(initialStores.map((storeName) => [storeName, new Map()])));
    }
    return databases.get(name);
  }

  function createDatabase(name) {
    const stores = ensureDatabase(name);
    return {
      objectStoreNames: {
        contains(storeName) {
          return stores.has(storeName);
        },
      },
      createObjectStore(storeName) {
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        return {};
      },
      close() {},
      transaction(storeNames) {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        let pendingRequests = 0;
        let completionScheduled = false;
        const transaction = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          objectStore(storeName) {
            if (!names.includes(storeName)) throw new Error(`Store ${storeName} is outside this transaction.`);
            const values = stores.get(storeName);
            if (!values) throw new Error(`Missing store ${storeName}.`);
            return createObjectStore(values, transaction, beginRequest, maybeComplete);
          },
        };

        function maybeComplete() {
          if (pendingRequests > 0 || completionScheduled) return;
          completionScheduled = true;
          queueMicrotask(() => {
            completionScheduled = false;
            if (pendingRequests === 0) transaction.oncomplete?.();
          });
        }

        function beginRequest(run) {
          pendingRequests += 1;
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            try {
              request.result = run();
              request.onsuccess?.();
            } catch (error) {
              request.error = error;
              transaction.error = error;
              request.onerror?.();
              transaction.onerror?.();
            } finally {
              pendingRequests -= 1;
              maybeComplete();
            }
          });
          return request;
        }

        maybeComplete();
        return transaction;
      },
    };
  }

  function createObjectStore(values, transaction, beginRequest, maybeComplete) {
    return {
      add(value, key = value.id) {
        return beginRequest(() => { if (values.has(String(key))) throw new Error('ConstraintError'); values.set(String(key), structuredClone(value)); return key; });
      },
      getAll() { return beginRequest(() => [...values.values()]); },
      get(key) {
        return beginRequest(() => values.get(String(key)));
      },
      put(value, key) {
        values.set(String(key), value);
        maybeComplete();
        return { result: key, error: null, onsuccess: null, onerror: null };
      },
      clear() {
        values.clear();
        maybeComplete();
        return { result: undefined, error: null, onsuccess: null, onerror: null };
      },
      delete(key) {
        values.delete(String(key));
        maybeComplete();
      },
      openCursor() {
        const entries = Array.from(values.entries());
        let index = 0;
        const request = { result: undefined, error: null, onsuccess: null, onerror: null };
        const emit = () => {
          queueMicrotask(() => {
            const entry = entries[index];
            if (!entry) {
              request.result = null;
              request.onsuccess?.();
              return;
            }
            request.result = {
              key: entry[0],
              value: entry[1],
              continue() {
                index += 1;
                emit();
              },
              delete() {
                values.delete(String(entry[0]));
              },
            };
            request.onsuccess?.();
          });
        };
        emit();
        return request;
      },
    };
  }

  return {
    indexedDB: {
      open(name) {
        const request = {
          result: createDatabase(String(name)),
          error: null,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          queueMicrotask(() => request.onsuccess?.());
        });
        return request;
      },
    },
    reset() {
      databases.forEach((stores) => stores.forEach((values) => values.clear()));
    },
    store(databaseName, storeName) {
      const values = ensureDatabase(databaseName).get(storeName);
      if (!values) throw new Error(`Missing ${databaseName}/${storeName}.`);
      return values;
    },
  };
}

const idb = createIndexedDbHarness();
globalThis.localStorage = new MemoryStorage();
globalThis.indexedDB = idb.indexedDB;
globalThis.window = {
  addEventListener() {},
  clearTimeout,
  dispatchEvent() {},
  removeEventListener() {},
  setTimeout,
};
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

const storage = await import('../src/storage.ts');
const notes = await import('../src/utils/noteStorage.ts');
const sync = await import('../src/utils/syncService.ts');
const syncState = await import('../src/utils/syncState.ts');
const coordination = await import('../src/utils/dataCoordination.ts');

const timestamp = '2026-08-15T00:00:00.000Z';
const syncId = '111111111111111111111111111111111111';
const noteKey = 'quizMake:notes:set-1:vocabulary';
const missingNoteKey = 'quizMake:notes:set-1:grammar';
const otherSetNoteKey = 'quizMake:notes:set-2:vocabulary';
const noteRaw = JSON.stringify({ dataUrl: 'data:image/png;base64,note', updatedAt: timestamp });
const appData = {
  ...storage.createEmptyAppData(),
  folders: [{ id: 'folder-1', name: 'Recovered', createdAt: timestamp, updatedAt: timestamp }],
};
const appRaw = JSON.stringify(appData);

function resetState() {
  localStorage.clear();
  idb.reset();
  coordination.resetDataCoordinationForTests();
}

function setMeaningfulSyncHistory() {
  localStorage.setItem(syncState.LAST_SYNC_AT_KEY, timestamp);
}

function setNoteManifest(keys) {
  localStorage.setItem(notes.CATEGORY_NOTES_MANIFEST_KEY, JSON.stringify({ version: 1, keys }));
}

function seedCurrentApp(raw = appRaw) {
  const store = idb.store('quiz-make-app-data-v1', 'appData');
  store.set(storage.APP_DATA_STORAGE_KEY, raw);
  store.set(`${storage.APP_DATA_STORAGE_KEY}:saved-at`, timestamp);
}

test('meaningful sync history blocks an authoritative empty export after app IDB loss but recovery export remains available', async () => {
  resetState();
  setMeaningfulSyncHistory();
  setNoteManifest([]);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('an untrusted export must fail before network access');
  };

  await assert.rejects(
    sync.exportQuizMakeData(timestamp),
    /空のバックアップ|空のバックアップには置き換えません|保存データを確認できない/u,
  );
  assert.equal(fetchCalls, 0);
  assert.notEqual(localStorage.getItem(storage.APP_DATA_RECOVERY_REQUIRED_KEY), null);

  const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
  assert.deepEqual(
    JSON.parse(recovery.localStorage[storage.APP_DATA_STORAGE_KEY]),
    storage.createEmptyAppData(),
  );
  const blockedUpload = await sync.uploadSyncData(syncId, recovery);
  assert.equal(blockedUpload.ok, false);
  if (!blockedUpload.ok) assert.match(blockedUpload.error, /復旧用/u);
  assert.equal(fetchCalls, 0);
});

test('loading app data from backup keeps authoritative export tainted even after an ordinary save', async () => {
  resetState();
  setMeaningfulSyncHistory();
  setNoteManifest([]);
  idb.store('quiz-make-app-data-v1', 'appDataBackups').set(storage.APP_DATA_STORAGE_KEY, appRaw);

  const loaded = await storage.loadAppDataAsync();
  assert.deepEqual(loaded, appData);
  assert.notEqual(localStorage.getItem(storage.APP_DATA_RECOVERY_REQUIRED_KEY), null);
  assert.equal(await storage.saveAppData(loaded), true);

  await assert.rejects(sync.exportQuizMakeData(timestamp), /復旧確認が必要/u);
  const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
  assert.deepEqual(JSON.parse(recovery.localStorage[storage.APP_DATA_STORAGE_KEY]), appData);
});

test('missing, partial, and backup-only note provenance fail closed while recovery export preserves available notes', async (t) => {
  await t.test('missing manifest after sync history', async () => {
    resetState();
    seedCurrentApp();
    setMeaningfulSyncHistory();
    idb.store('quiz-make-notes-v1', 'categoryNotes').set(noteKey, noteRaw);

    await assert.rejects(sync.exportQuizMakeData(timestamp), /ノート保存状態|クラウドから読み込んで/u);
    const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
    assert.equal(recovery.indexedDbNotes?.[noteKey], noteRaw);
  });

  await t.test('manifest expects a missing note', async () => {
    resetState();
    seedCurrentApp();
    setNoteManifest([noteKey, missingNoteKey]);
    idb.store('quiz-make-notes-v1', 'categoryNotes').set(noteKey, noteRaw);

    await assert.rejects(sync.exportQuizMakeData(timestamp), /一部が端末から消えている/u);
    const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
    assert.equal(recovery.indexedDbNotes?.[noteKey], noteRaw);
  });

  await t.test('note exists only in the recovery backup store', async () => {
    resetState();
    seedCurrentApp();
    setNoteManifest([noteKey]);
    idb.store('quiz-make-notes-v1', 'categoryNoteBackups').set(noteKey, noteRaw);

    await assert.rejects(sync.exportQuizMakeData(timestamp), /復旧用バックアップにしか残っていない/u);
    const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
    assert.equal(recovery.indexedDbNotes?.[noteKey], noteRaw);
  });
});

test('cloud replacement re-establishes app and note authority and clears prior taint', async () => {
  resetState();
  sync.setStoredSyncId(syncId);
  sync.setLastSyncState({ lastSyncAt: timestamp, lastRemoteUpdatedAt: timestamp });
  localStorage.setItem(storage.APP_DATA_RECOVERY_REQUIRED_KEY, JSON.stringify({ version: 1, reason: 'missing-primary' }));
  localStorage.setItem(notes.CATEGORY_NOTES_RECOVERY_REQUIRED_KEY, JSON.stringify({ version: 1, reason: 'missing-manifest' }));

  const imported = await sync.importQuizMakeData({
    version: 1,
    updatedAt: timestamp,
    localStorage: { [storage.APP_DATA_STORAGE_KEY]: appRaw },
    indexedDbNotes: { [noteKey]: noteRaw },
  }, {
    expectedSyncId: syncId,
    authoritativeUpdatedAt: timestamp,
  });

  assert.equal(imported.ok, true);
  assert.equal(idb.store('quiz-make-backups', 'backups').size, 1, 'replacement keeps a durable pre-import snapshot');
  assert.equal(localStorage.getItem(storage.APP_DATA_RECOVERY_REQUIRED_KEY), null);
  assert.equal(localStorage.getItem(notes.CATEGORY_NOTES_RECOVERY_REQUIRED_KEY), null);
  assert.deepEqual(JSON.parse(localStorage.getItem(notes.CATEGORY_NOTES_MANIFEST_KEY)), {
    version: 1,
    keys: [noteKey],
  });

  const exported = await sync.exportQuizMakeData(timestamp);
  assert.deepEqual(JSON.parse(exported.localStorage[storage.APP_DATA_STORAGE_KEY]), appData);
  assert.equal(exported.indexedDbNotes?.[noteKey], noteRaw);
});

test('scoped note deletion never legitimizes an unrelated note that is already missing', async () => {
  resetState();
  seedCurrentApp();
  setMeaningfulSyncHistory();
  setNoteManifest([noteKey, otherSetNoteKey]);

  assert.equal(await notes.deleteCategoryNotesForProblemSetIds(['set-1']), 0);
  assert.deepEqual(JSON.parse(localStorage.getItem(notes.CATEGORY_NOTES_MANIFEST_KEY)), {
    version: 1,
    keys: [otherSetNoteKey],
  });
  await assert.rejects(sync.exportQuizMakeData(timestamp), /一部が端末から消えている/u);
});

test('recovery export never replaces a current note with an older backup', async () => {
  resetState();
  seedCurrentApp();
  const current = JSON.stringify({ dataUrl: 'current' });
  const backup = JSON.stringify({ dataUrl: 'backup' });
  idb.store('quiz-make-notes-v1', 'categoryNotes').set(noteKey, current);
  idb.store('quiz-make-notes-v1', 'categoryNoteBackups').set(noteKey, backup);
  setNoteManifest([noteKey]);

  const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
  assert.equal(recovery.indexedDbNotes?.[noteKey], current);
});

test('an explicit local recovery decision can re-establish app authority', async () => {
  resetState();
  seedCurrentApp();
  setNoteManifest([]);
  localStorage.setItem(storage.APP_DATA_RECOVERY_REQUIRED_KEY, JSON.stringify({ version: 1, reason: 'backup-only' }));

  await assert.rejects(sync.exportQuizMakeData(timestamp), /復旧確認が必要/u);
  assert.equal(storage.establishCurrentAppDataAuthority(), true);
  const exported = await sync.exportQuizMakeData(timestamp);
  assert.deepEqual(JSON.parse(exported.localStorage[storage.APP_DATA_STORAGE_KEY]), appData);
});

test('unreadable recovery and import markers fail closed for authoritative export', async (t) => {
  await t.test('app recovery-required marker read failure', async () => {
    resetState();
    seedCurrentApp();
    setNoteManifest([]);
    localStorage.failReadsFor.add(storage.APP_DATA_RECOVERY_REQUIRED_KEY);

    await assert.rejects(storage.exportAppDataRaw(), /復旧確認が必要/u);
    const recovery = await storage.exportAppDataRaw({ mode: 'recovery' });
    assert.deepEqual(JSON.parse(recovery), appData);
  });

  await t.test('data import-in-progress marker read failure', async () => {
    resetState();
    seedCurrentApp();
    setNoteManifest([]);
    localStorage.failReadsFor.add('quizMake:sync:dataImportInProgress');

    await assert.rejects(sync.exportQuizMakeData(timestamp), /前回のデータ読込/u);
    const recovery = await sync.exportQuizMakeRecoveryData(timestamp);
    assert.deepEqual(JSON.parse(recovery.localStorage[storage.APP_DATA_STORAGE_KEY]), appData);
  });
});

test('corrupt non-empty sync history fails closed', () => {
  resetState();
  localStorage.setItem(syncState.LAST_SYNC_AT_KEY, 'not-a-timestamp');
  assert.equal(syncState.hasPersistedSyncHistory(), true);

  resetState();
  localStorage.setItem(syncState.LAST_REMOTE_UPDATED_AT_KEY, '   ');
  assert.equal(syncState.hasPersistedSyncHistory(), true);

  resetState();
  localStorage.setItem(syncState.LAST_SYNC_RECORD_KEY, '{broken');
  assert.equal(syncState.hasPersistedSyncHistory(), true);

  resetState();
  localStorage.setItem(syncState.LAST_SYNC_RECORD_KEY, JSON.stringify({
    owner: syncId,
    state: {
      lastSyncAt: 'not-a-timestamp',
      lastUploadHash: '',
      lastRemoteUpdatedAt: '',
      status: '自動同期OFF',
      error: '',
    },
  }));
  assert.equal(syncState.hasPersistedSyncHistory(), true);
});

test('a status-only atomic sync record is not history and permits a first empty authoritative export', async () => {
  resetState();
  localStorage.setItem(syncState.LAST_SYNC_RECORD_KEY, JSON.stringify({
    owner: syncId,
    state: {
      lastSyncAt: '',
      lastUploadHash: '',
      lastRemoteUpdatedAt: '',
      status: '自動同期OFF',
      error: '',
    },
  }));

  assert.equal(syncState.hasPersistedSyncHistory(), false);
  const exported = await sync.exportQuizMakeData(timestamp);
  assert.deepEqual(JSON.parse(exported.localStorage[storage.APP_DATA_STORAGE_KEY]), storage.createEmptyAppData());
  assert.deepEqual(exported.indexedDbNotes, {});
});
