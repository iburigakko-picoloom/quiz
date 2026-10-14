import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { largeNoteRaw } from './helpers/large-note-fixture.mjs';

globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
globalThis.window = { dispatchEvent() {} };
const storage = await import('../src/storage.ts');
const notes = await import('../src/utils/noteStorage.ts');
const { accountLocalStorage } = await import('../src/utils/accountStorage.ts');
await storage.saveAppDataAsync(storage.createEmptyAppData());
const db = await storage.openAppDb(); after(() => db.close());
const key = 'quizMake:notes:s:large-ink', raw = largeNoteRaw('2026-10-14T00:00:00Z', 's', 'large-ink');
await notes.saveCategoryNoteRaw(key, raw);
const write = async (store, value) => {
  const tx = db.transaction(store, 'readwrite');
  if (value === null) tx.objectStore(store).delete(key); else tx.objectStore(store).put(value, key);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
};

test('a healthy large note does not read its recovery copy, even if that store is unavailable', async () => {
  const get = IDBObjectStore.prototype.get, reads = [];
  IDBObjectStore.prototype.get = function(value) {
    if (value === key && ['categoryNotes', 'categoryNoteBackups'].includes(this.name)) {
      reads.push(this.name); if (this.name === 'categoryNoteBackups') throw new Error('unavailable recovery store');
    }
    return get.call(this, value);
  };
  try { assert.equal(await notes.loadCategoryNoteRaw(key), raw); }
  finally { IDBObjectStore.prototype.get = get; }
  assert.deepEqual(reads, ['categoryNotes']);
});

test('newer durable legacy content still wins over a valid current note without consulting recovery', async () => {
  const newer = JSON.stringify({ dataUrl: 'legacy latest', updatedAt: '2026-10-15T00:00:00Z' });
  accountLocalStorage.setItem(key, newer);
  try { assert.equal(await notes.loadCategoryNoteRaw(key), newer); }
  finally { accountLocalStorage.removeItem(key); }
});

test('missing and corrupt originals still recover the exact saved backup, while all-invalid data is never blank', async () => {
  await write('categoryNoteBackups', raw);
  for (const current of [null, '{broken']) {
    await write('categoryNotes', current);
    assert.equal(await notes.loadCategoryNoteRaw(key), raw);
    assert.ok(notes.getNoteBackupIssues({ [key]: raw }).some(issue => issue.includes('復旧')));
  }
  await write('categoryNoteBackups', '{also broken');
  await assert.rejects(notes.loadCategoryNoteRaw(key), /Stored category note data is invalid/);
  await write('categoryNotes', raw); await write('categoryNoteBackups', raw);
});

test('an unreadable primary cannot turn into an older backup or empty editable canvas', async () => {
  const get = IDBObjectStore.prototype.get, warn = console.warn;
  console.warn = () => {};
  IDBObjectStore.prototype.get = function(value) {
    if (this.name === 'categoryNotes' && value === key) throw new Error('primary read failed');
    return get.call(this, value);
  };
  try { await assert.rejects(notes.loadCategoryNoteRaw(key), /Failed to read category note data/); }
  finally { IDBObjectStore.prototype.get = get; console.warn = warn; }
});
