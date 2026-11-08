import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';

globalThis.indexedDB = new IDBFactory();
const values = new Map();
globalThis.localStorage = { get length(){return values.size;}, key:i=>[...values.keys()][i]??null, getItem:k=>values.get(k)??null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k) };
const { writeMaterialCover, readMaterialCover, peekMaterialCover, rememberMaterialCover } = await import('../src/utils/materialCoverCache.ts');
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('quiz-make-material-cover-v1', 1);
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});

test('in-memory previews are reused immediately but invalidated by note changes', () => {
  const page = { id:'page', kind:'pdf', pdfPage:1 }, preview = { url:'data:image/png;base64,AA==', inkUrl:'data:image/png;base64,AQ==', aspect:0.7 };
  rememberMaterialCover('set', 'material', page, preview);
  assert.deepEqual(peekMaterialCover('set', 'material', page), preview);
  assert.equal(peekMaterialCover('other-set', 'material', page), null);
  localStorage.setItem('quizMake:coord:noteEpoch', 'changed');
  assert.equal(peekMaterialCover('set', 'material', page), null);
});
const count = db => new Promise((resolve, reject) => {
  const request = db.transaction('covers').objectStore('covers').count();
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});

test('disposable cover cache is bounded and never retains oversized images', async () => {
  const preview = { url: 'data:image/png;base64,AA==', aspect: 0.7 };
  for (let i = 0; i < 90; i++) await writeMaterialCover(`cover-${i}`, preview);
  const db = await open();
  try {
    assert.equal(await count(db), 80);
    await writeMaterialCover('too-large', { url: 'data:image/png;base64,' + 'A'.repeat(200_001), aspect: 0.7 });
    assert.equal(await count(db), 80);
    assert.equal(await readMaterialCover('too-large'), null);
  } finally { db.close(); }
});
