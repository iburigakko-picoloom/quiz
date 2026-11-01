import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { incomingFixture } from './helpers/whole-incoming-fixture.mjs';

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.window = { dispatchEvent() {} };
Object.defineProperty(navigator, 'locks', { value: { request: async (_name, _options, run) => run() }, configurable: true });
const storage = await import('../src/storage.ts');
const db = await storage.openAppDb();
after(() => db.close());
const { assertQuestionMaterialReferences, assertMaterialIntegrity, SyncDataError } = await import('../src/utils/syncDataIntegrity.ts');
const { appSaveFailureMessage, materialReferenceSaveFailure } = await import('../src/utils/appSaveFailure.ts');
const { replaceCategoryNotesRaw } = await import('../src/utils/noteStorage.ts');
const { readAppOutbox } = await import('../src/utils/appRecordStorage.ts');
const ref = { materialId: 'pdf-0', pageId: 'page-0' };
const indexKey = owner => `quizMake:notes:${owner}:__materials_v1`;
const fileKey = owner => `quizMake:notes:${owner}:__material_pdf_pdf-0`;

async function fixture() {
  const f = await incomingFixture({ count: 2 });
  f.data.questions[0].materialReferences = [ref];
  const notes = { ...f.payload.indexedDbNotes };
  // Same-owner PDF loss, a different live owner's PDF loss, a deleted owner's
  // leftover index, and an unrelated corrupt note all coexist with a valid ref.
  delete notes['quizMake:notes:s:__material_pdf_pdf-1'];
  const index = JSON.parse(notes[indexKey('s')]);
  for (const owner of ['other', 'deleted']) {
    notes[indexKey(owner)] = JSON.stringify({ ...index, problemSetId: owner, materials: [{ ...index.materials[1], id: owner }] });
  }
  notes['quizMake:notes:other:broken-note'] = '{broken';
  f.data.problemSets.push({ ...f.data.problemSets[0], id: 'other' });
  return { data: f.data, notes };
}

test('reference-only validation reads live indexes and referenced PDFs; complete validation stays strict', async () => {
  const { data, notes } = await fixture();
  const reads = [];
  await assertQuestionMaterialReferences(data, async key => { reads.push(key); return notes[key] ?? null; });
  assert.deepEqual(reads.sort(), [indexKey('s'), indexKey('other'), fileKey('s')].sort());
  assert.throws(() => assertMaterialIntegrity({ localStorage: {}, indexedDbNotes: notes }, data, false), e => e.code === 'pdf_missing');
  const noRefs = { ...data, questions: [{ ...data.questions[0], materialReferences: [] }] };
  await assertQuestionMaterialReferences(noRefs, async () => assert.fail('clearing references needs no media reads'));
});

test('missing targets, pages, PDF bodies, bad indexes and ambiguous live owners remain failures', async () => {
  const cases = [
    ['missing_material', ({ notes }) => { delete notes[indexKey('s')]; }],
    ['missing_page', ({ data }) => { data.questions[0].materialReferences = [{ ...ref, pageId: 'removed' }]; }],
    ['missing_pdf', ({ notes }) => { delete notes[fileKey('s')]; }],
    ['invalid_pdf', ({ notes }) => { notes[fileKey('s')] = '{}'; }],
    ['invalid_index', ({ notes }) => { notes[indexKey('s')] = '{broken'; }],
    ['index_identity', ({ notes }) => { notes[indexKey('s')] = notes[indexKey('other')]; }],
    ['ambiguous_material', ({ notes }) => {
      notes[indexKey('other')] = JSON.stringify({ ...JSON.parse(notes[indexKey('s')]), problemSetId: 'other' });
      notes[fileKey('other')] = notes[fileKey('s')];
    }],
    ['missing_material', ({ data }) => { data.problemSets = data.problemSets.filter(s => s.id !== 's'); }],
  ];
  for (const [reason, mutate] of cases) {
    const f = await fixture(); mutate(f);
    await assert.rejects(assertQuestionMaterialReferences(f.data, async key => f.notes[key] ?? null), e => e.diagnostic.referenceIssues[0].reason === reason);
  }
});

test('a reference into another live set is valid and storage read errors are not swallowed', async () => {
  const { data, notes } = await fixture();
  data.questions[0].setId = 'other';
  await assertQuestionMaterialReferences(data, async key => notes[key] ?? null);
  const error = new DOMException('private-path', 'SecurityError');
  await assert.rejects(assertQuestionMaterialReferences(data, async () => { throw error; }), e => e === error);
});

test('save succeeds with unrelated corruption; target failure or read denial preserves app records and outbox', async () => {
  const { data, notes } = await fixture();
  const brokenKey = 'quizMake:notes:other:broken-note';
  const validNotes = { ...notes }; delete validNotes[brokenKey];
  await replaceCategoryNotesRaw(validNotes);
  values.set(brokenKey, notes[brokenKey]);
  assert.deepEqual(await storage.saveAppDataResult(data, { materialReferenceQuestionIds: ['q'] }), { ok: true });
  assert.equal(values.get(brokenKey), notes[brokenKey]);
  const before = await storage.loadAppDataAsync(), outbox = await readAppOutbox(db);
  const draft = structuredClone(before);
  draft.questions[0].materialReferences = [{ ...ref, pageId: 'gone' }];
  const failed = await storage.saveAppDataResult(draft, { materialReferenceQuestionIds: ['q'] });
  assert.equal(failed.ok, false);
  assert.equal(failed.failure.referenceIssue, 'missing_page');
  assert.match(appSaveFailureMessage(failed.failure), /material_reference\/SyncDataError\/missing_page/);
  assert.doesNotMatch(appSaveFailureMessage(failed.failure), /問題データの形式/);
  assert.deepEqual(await storage.loadAppDataAsync(), before);
  assert.deepEqual(await readAppOutbox(db), outbox);
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function(key) {
    if (this.name === 'categoryNotes' && key === indexKey('s')) throw new DOMException('secret-path', 'SecurityError');
    return get.call(this, key);
  };
  try {
    const denied = await storage.saveAppDataResult(before, { materialReferenceQuestionIds: ['q'] });
    assert.equal(denied.ok, false);
    assert.equal(denied.failure.code, 'storage_blocked');
    assert.match(appSaveFailureMessage(denied.failure), /material_reference\/SecurityError/);
    assert.doesNotMatch(JSON.stringify(denied), /secret-path/);
  } finally { IDBObjectStore.prototype.get = get; }
  assert.deepEqual(await storage.loadAppDataAsync(), before);
  assert.deepEqual(await readAppOutbox(db), outbox);
  assert.deepEqual(await storage.saveAppDataResult(before, { materialReferenceQuestionIds: ['q'] }), { ok: true });
});

test('diagnostics retain bounded cause categories without disclosing IDs or exception text', () => {
  const error = new SyncDataError('pdf_missing', 'secret PDF path', { function: 'materialReferences', stage: 'material_references', referenceIssues: [{ reason: 'missing_pdf', questionId: 'secret-question', materialId: 'secret-material' }], issueCount: 1 });
  const failure = materialReferenceSaveFailure(error);
  assert.equal(failure.referenceIssue, 'missing_pdf');
  assert.doesNotMatch(JSON.stringify(failure) + appSaveFailureMessage(failure), /secret/);
  const read = materialReferenceSaveFailure(new Error('private storage detail'));
  assert.equal(read.code, 'material_read');
  assert.match(appSaveFailureMessage(read), /読み取れません/);
  assert.doesNotMatch(appSaveFailureMessage(read), /変更・削除|private/);
});
