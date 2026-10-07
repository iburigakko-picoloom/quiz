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

const { persistLibraryDeletion } = await import('../src/utils/libraryDeletion.ts');

const previousData = {
  version: 1,
  folders: [{ id: 'folder-1', name: 'Before', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
  problemSets: [],
  questions: [],
  progress: [],
  answerLogs: [],
};
const nextData = { ...previousData, folders: [] };

test('inbound material reference is checked inside deletion coordination and refuses every destructive write',async()=>{
  let locked=false,writes=0;
  const current={...previousData,problemSets:[{id:'owner',title:'資料の持ち主'},{id:'dependent',title:'参照する教材'}],questions:[{id:'q',setId:'dependent',materialReferences:[{materialId:'pdf-1',pageId:'p'}]}]};
  const deps={waitForAppSaves:async()=>true,waitForNoteSaves:async()=>{},coordinate:async operation=>{locked=true;try{return await operation();}finally{locked=false;}},loadAppData:async()=>current,saveAppData:async()=>{writes++;return true;},deleteNotes:async()=>{writes++;},readMaterialIds:async ids=>{assert.equal(locked,true);assert.deepEqual(ids,['owner']);return new Set(['pdf-1']);}};
  const result=await persistLibraryDeletion({buildPlan:()=>({nextData,problemSetIds:['owner']})},deps);
  assert.equal(result.ok,false);assert.equal(result.reason,'referenced-material');assert.match(result.error.message,/参照する教材/);assert.equal(writes,0);
  const together=await persistLibraryDeletion({buildPlan:()=>({nextData,problemSetIds:['owner','dependent']})},{...deps,readMaterialIds:async()=>new Set(['pdf-1'])});
  assert.equal(together.ok,true);assert.equal(writes,2);
});

function createDependencies({ noteError = null, restoreSucceeds = true, coordinateError = null } = {}) {
  const calls = [];
  let saveCount = 0;
  return {
    calls,
    dependencies: {
      waitForAppSaves: async () => {
        calls.push('wait-app');
        return true;
      },
      waitForNoteSaves: async () => {
        calls.push('wait-notes');
      },
      coordinate: async (operation) => {
        calls.push('coordinate');
        if (coordinateError) throw coordinateError;
        return operation();
      },
      loadAppData: async () => {
        calls.push('load-current');
        return previousData;
      },
      saveAppData: async (data) => {
        saveCount += 1;
        calls.push(data === nextData ? 'save-next' : 'save-previous');
        return saveCount === 1 || restoreSucceeds;
      },
      deleteNotes: async (ids, deleteAll) => {
        calls.push(`delete:${ids.join(',')}:${deleteAll}`);
        if (noteError) throw noteError;
      },
    },
  };
}

test('library deletion saves AppData and notes under one coordinated operation', async () => {
  const { calls, dependencies } = createDependencies();
  const result = await persistLibraryDeletion({
    buildPlan: () => ({ nextData, problemSetIds: ['set-1'] }),
  }, dependencies);

  assert.deepEqual(result, { ok: true, data: nextData });
  assert.deepEqual(calls, [
    'wait-app',
    'wait-notes',
    'coordinate',
    'load-current',
    'save-next',
    'delete:set-1:false',
  ]);
});

test('a note deletion failure restores the exact previous AppData before releasing coordination', async () => {
  const noteError = new Error('note store unavailable');
  const { calls, dependencies } = createDependencies({ noteError });
  const result = await persistLibraryDeletion({
    buildPlan: () => ({ nextData, problemSetIds: ['set-1', 'set-2'] }),
  }, dependencies);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'notes-delete-failed');
  assert.equal(result.error, noteError);
  assert.deepEqual(calls.slice(-3), [
    'save-next',
    'delete:set-1,set-2:false',
    'save-previous',
  ]);
});

test('a failed rollback is reported instead of pretending the original data was restored', async () => {
  const { dependencies } = createDependencies({ noteError: new Error('delete failed'), restoreSucceeds: false });
  const result = await persistLibraryDeletion({
    buildPlan: () => ({ nextData, problemSetIds: [] }),
    deleteAllNotes: true,
  }, dependencies);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rollback-failed');
});

test('a cross-tab coordination failure prevents all persistent writes', async () => {
  const { calls, dependencies } = createDependencies({ coordinateError: new Error('changed elsewhere') });
  const result = await persistLibraryDeletion({
    buildPlan: () => ({ nextData, problemSetIds: ['set-1'] }),
  }, dependencies);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'coordination-failed');
  assert.equal(calls.includes('save-next'), false);
  assert.equal(calls.some((call) => call.startsWith('delete:')), false);
});

test('a deletion plan is built from the latest durable data after waiting for coordination', async () => {
  const importedData = {
    ...previousData,
    folders: [
      ...previousData.folders,
      { id: 'folder-cloud', name: 'Cloud import', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
    ],
  };
  const calls = [];
  let savedData = null;
  const result = await persistLibraryDeletion({
    buildPlan: (currentData) => {
      assert.equal(currentData, importedData);
      return {
        nextData: { ...currentData, folders: currentData.folders.filter((folder) => folder.id !== 'folder-1') },
        problemSetIds: [],
      };
    },
  }, {
    waitForAppSaves: async () => true,
    waitForNoteSaves: async () => undefined,
    coordinate: async (operation) => {
      calls.push('lock');
      return operation();
    },
    loadAppData: async () => {
      calls.push('load-after-lock');
      return importedData;
    },
    saveAppData: async (data) => {
      savedData = data;
      return true;
    },
    deleteNotes: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(savedData.folders.some((folder) => folder.id === 'folder-cloud'), true);
  assert.deepEqual(calls, ['lock', 'load-after-lock']);
});
