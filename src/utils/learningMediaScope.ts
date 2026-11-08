import { idbDone } from './blobVault';

/** Read question/image metadata only, never PDF or backup bodies. */
export async function requiredQuestionImageHashes(db: IDBDatabase): Promise<Set<string>> {
  const tx = db.transaction('appRecords'), done = idbDone(tx), store = tx.objectStore('appRecords');
  const keys = store.getAllKeys();
  const rows: Array<{ collection: string; id: string; raw: string | null; logicalRaw?: string }> = [];
  keys.onsuccess = () => {
    for (const key of keys.result) {
      const [collection] = JSON.parse(String(key));
      if (collection !== 'questions' && collection !== 'questionImages') continue;
      const request = store.get(key);
      request.onsuccess = () => { if (request.result) rows.push(request.result); };
    }
  };
  await done;
  const needed = new Map<string, Set<string>>();
  for (const row of rows) if (row.collection === 'questions' && row.raw) {
    const question = JSON.parse(row.logicalRaw ?? row.raw);
    needed.set(row.id, new Set([...(question.questionImageIds ?? []), ...(question.detailedAnswer?.imageIds ?? [])]));
  }
  const hashes = new Set<string>();
  for (const row of rows) if (row.collection === 'questionImages' && row.raw) {
    const image = JSON.parse(row.raw);
    if (needed.get(image.questionId)?.has(row.id) && typeof image.sha256 === 'string') hashes.add(image.sha256);
  }
  return hashes;
}
