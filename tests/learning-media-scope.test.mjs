import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { requiredQuestionImageHashes } from '../src/utils/learningMediaScope.ts';
test('only live question and explanation images are eligible; PDF bodies are not read', async () => {
  const factory = new IDBFactory();
  const db = await new Promise((resolve, reject) => {
    const r = factory.open('scope', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('appRecords');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('appRecords', 'readwrite'), store = tx.objectStore('appRecords');
      const put = (collection, id, value) => store.put({ collection, id, raw: value === null ? null : JSON.stringify(value) }, JSON.stringify([collection, id]));
      put('questions', 'q', { questionImageIds: ['a'], detailedAnswer: { imageIds: ['b'] } });
      put('questions', 'deleted', null);
      put('questionImages', 'a', { questionId: 'q', sha256: 'question' });
      put('questionImages', 'b', { questionId: 'q', sha256: 'explanation' });
      put('questionImages', 'unused', { questionId: 'q', sha256: 'unused' });
      put('questionImages', 'old', { questionId: 'deleted', sha256: 'deleted' });
      // Invalid body proves that excluded documents are never parsed.
      store.put({ collection: 'indexedDbNotes', id: 'pdf', raw: 'not JSON' }, '["indexedDbNotes","pdf"]');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    assert.deepEqual([...await requiredQuestionImageHashes(db)].sort(), ['explanation', 'question']);
  } finally { db.close(); }
});
