import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createServer } from 'vite';

const values = new Map();
let rejectKey = '';
globalThis.localStorage = {
  get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
  getItem: key => values.get(key) ?? null,
  setItem(key, value) { if (key === rejectKey) { rejectKey = ''; throw new Error('quota'); } values.set(key, String(value)); },
  removeItem: key => values.delete(key),
};
globalThis.window = { location: new URL('http://localhost/quiz/'), dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
globalThis.indexedDB = new IDBFactory();
process.env.VITE_SUPABASE_URL = 'https://snapshot-test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-only-key';
const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
const storage = await vite.ssrLoadModule('/src/storage.ts');
const sync = await vite.ssrLoadModule('/src/utils/syncService.ts');
const snapshots = await vite.ssrLoadModule('/src/utils/snapshotQuestionImages.ts');
const images = await vite.ssrLoadModule('/src/utils/questionImageRecords.ts');
const backups = await vite.ssrLoadModule('/src/utils/backupRepository.ts');
const { createSampleAppData } = await vite.ssrLoadModule('/src/utils/sampleData.ts');
const syncId = '111111111111111111111111111111111111';
const userId = '00000000-0000-4000-8000-000000000001';
sync.setSyncAccessTokenProviderForTests(async () => ({ ok: true, accessToken: 'test-access', userId }));

after(async () => { await vite.close(); });
const blob = text => new Blob([text], { type: 'image/png' });
async function fixture(prefix) {
  const sample = createSampleAppData();
  const question = { ...sample.questions[0], questionImageIds: [`${prefix}-question`], detailedAnswer: { body: '説明', imageIds: [`${prefix}-detail`], updatedAt: sample.questions[0].updatedAt } };
  const data = { ...sample, questions: [question] };
  assert.equal(await storage.saveAppData(data), true);
  for (const id of [...question.questionImageIds, ...question.detailedAnswer.imageIds]) await images.saveQuestionImage({ id, questionId: question.id, name: `${id}.png`, type: 'image/png', blob: blob(id), addedAt: '2026-10-07T01:00:00Z' });
  sync.setStoredSyncId(syncId);
  return { data, question, payload: await sync.exportQuizMakeRecoveryData() };
}

test('whole-data backups include question and explanation image bodies and restore them on a fresh device', async () => {
  const { payload, question } = await fixture('portable');
  assert.equal(sync.validateSyncPayload(payload).ok, true);
  const saved = await backups.saveBackupPayload(payload, 'before-sync');
  const reread = JSON.parse((await backups.getSavedBackup(saved.id)).raw);
  assert.equal((await snapshots.verifySnapshotQuestionImages(reread)).length, 2);
  assert.equal(await storage.saveAppData(storage.createEmptyAppData()), true);
  await images.removeQuestionImages(() => true);
  const result = await sync.importQuizMakeData(reread);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await storage.loadAppDataAsync()).questions[0].detailedAnswer.imageIds, question.detailedAnswer.imageIds);
  const restored = await images.readQuestionImages(question.id, [...question.questionImageIds, ...question.detailedAnswer.imageIds]);
  assert.equal(restored.length, 2);
  assert.deepEqual(await Promise.all(restored.map(row => row.blob.text())), ['portable-question', 'portable-detail']);
  assert.equal([...values.keys()].some(key => key.startsWith('quizMake:image:')), false, 'large bodies stay out of localStorage');
});

test('whole-data image transport sends bodies before metadata, validates ownership, and preserves the snapshot digest', async () => {
  const { payload } = await fixture('transport');
  const uploaded = new Map();
  const transport = { userId, exists: async descriptor => uploaded.has(descriptor.path), upload: async (descriptor, body) => { uploaded.set(descriptor.path, body); }, download: async descriptor => uploaded.get(descriptor.path) };
  const wire = await snapshots.prepareSnapshotQuestionImageUpload(payload, transport);
  assert.equal(uploaded.size, 2);
  assert.equal(sync.validateSyncPayload(wire, { wire: true }).ok, true);
  assert.equal(sync.validateSyncPayload(wire).ok, false, 'unfetched pointers cannot replace local data');
  assert.equal(JSON.stringify(wire).includes('data:image/png;base64,'), false);
  assert.equal(await sync.computePayloadDigest(wire), await sync.computePayloadDigest(payload));
  const portable = await snapshots.hydrateSnapshotQuestionImages(wire, transport);
  assert.equal(sync.validateSyncPayload(portable).ok, true);
  assert.equal((await snapshots.verifySnapshotQuestionImages(portable)).length, 2);
  await assert.rejects(() => snapshots.hydrateSnapshotQuestionImages(wire, { ...transport, userId: '00000000-0000-4000-8000-000000000002' }), /所有者/);
});

test('missing, misattached and corrupted images fail before replacement or backup acceptance', async () => {
  const { payload } = await fixture('invalid');
  const key = 'quizMake:image:invalid-question';
  const missing = structuredClone(payload); delete missing.localStorage[key];
  assert.equal(sync.validateSyncPayload(missing).ok, false);
  const misattached = structuredClone(payload);
  misattached.localStorage[key] = JSON.stringify({ ...JSON.parse(payload.localStorage[key]), questionId: 'another-question' });
  assert.equal(sync.validateSyncPayload(misattached).ok, false);
  const corrupted = structuredClone(payload);
  const image = JSON.parse(corrupted.localStorage[key]);
  image.dataUrl = image.dataUrl.replace(/.$/, image.dataUrl.endsWith('A') ? 'B' : 'A');
  corrupted.localStorage[key] = JSON.stringify(image);
  await assert.rejects(() => backups.saveBackupPayload(corrupted, 'before-sync'), /画像/);
  const before = await storage.loadAppDataAsync();
  assert.equal((await sync.importQuizMakeData(corrupted)).ok, false);
  assert.deepEqual(await storage.loadAppDataAsync(), before);
});

test('failed whole-data replacement rolls back the original image bodies as well as questions', async () => {
  const { payload: before, question } = await fixture('rollback');
  const changed = structuredClone(before);
  const key = 'quizMake:image:rollback-question';
  const descriptor = await images.describeQuestionImage({ id: 'rollback-question', questionId: question.id, name: 'new.png', type: 'image/png', blob: blob('replacement'), addedAt: '2026-10-07T02:00:00Z' });
  changed.localStorage[key] = JSON.stringify({ ...descriptor, dataUrl: 'data:image/png;base64,' + btoa('replacement') });
  changed.localStorage['quizMake:test:write-failure'] = 'new';
  rejectKey = 'quizMake:test:write-failure';
  const result = await sync.importQuizMakeData(changed);
  assert.equal(result.ok, false);
  assert.match(result.error, /既存データへ戻しました/);
  const [original] = await images.readQuestionImages(question.id, ['rollback-question']);
  assert.equal(await original.blob.text(), 'rollback-question');
  assert.equal(await sync.computePayloadDigest(await sync.exportQuizMakeRecoveryData()), await sync.computePayloadDigest(before));
});

test('the full snapshot RPC carries verified image descriptors and returns a portable local result', async () => {
  await fixture('rpc');
  const payload = await sync.exportQuizMakeData();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    if (init.method === 'HEAD') return new Response(null, { status: 200 });
    const body = JSON.parse(init.body);
    assert.equal(JSON.stringify(body.p_data).includes('data:image/png;base64,'), false);
    return new Response(JSON.stringify([{ result_code: 'ok', sync_id: syncId, data: body.p_data, updated_at: body.p_updated_at }]), { status: 200 });
  };
  const result = await sync.uploadSyncData(syncId, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 2);
  assert.match(requests.at(-1).url, /quiz_sync_upsert_v2$/);
  assert.equal((await snapshots.verifySnapshotQuestionImages(result.value.payload)).length, 2);
});

test('legacy record sync retires only after both portable backups, while keeping staged conflicts and original Blobs', async () => {
  const { payload, question } = await fixture('migration');
  const wire = await snapshots.prepareSnapshotQuestionImageUpload(payload, { userId, exists: async () => true, upload: async () => {}, download: async () => { throw new Error('not needed'); } });
  const stamp = '2026-10-07T03:00:00Z';
  const user = { id: userId, email: 'test@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: stamp };
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/auth/v1/user') ? user : String(url).endsWith('/quiz_sync_read')
    ? [{ sync_id: syncId, updated_at: stamp, data: wire }] : [{ sync_id: syncId, updated_at: stamp }]), { status: 200 });
  const cloud = await vite.ssrLoadModule('/src/utils/cloudService.ts');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
  const session = await cloud.cloudClient.auth.setSession({ access_token: token, refresh_token: 'test-refresh' });
  assert.equal(session.error, null);
  const optIn = await vite.ssrLoadModule('/src/utils/recordSyncOptIn.ts');
  const migration = await vite.ssrLoadModule('/src/utils/wholeSyncMigration.ts');
  optIn.setRecordSyncOptIn(syncId, true);
  sync.setAutoSyncEnabled(true);
  const db = await images.openQuestionImageRecordDb();
  const tx = db.transaction('appRecordConflicts', 'readwrite');
  const completed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
  tx.objectStore('appRecordConflicts').put({ retained: true }, 'old-conflict'); await completed;
  const count = (await backups.listSavedBackups()).length;
  await migration.migrateToWholeSync(syncId, userId);
  assert.equal(optIn.isRecordSyncOptedIn(syncId), false);
  assert.equal(sync.getAutoSyncSettings().enabled, false);
  assert.equal(sync.getLastSyncState().lastSyncAt, '', 'a whole snapshot must be selected before automatic writes');
  const rows = await backups.listSavedBackups();
  assert.equal(rows.length, count + 2);
  for (const row of rows.slice(0, 2)) assert.equal((await snapshots.verifySnapshotQuestionImages(JSON.parse((await backups.getSavedBackup(row.id)).raw))).length, 2);
  const read = db.transaction('appRecordConflicts');
  const readDone = new Promise(resolve => { read.oncomplete = resolve; });
  const retained = read.objectStore('appRecordConflicts').get('old-conflict'); await readDone;
  assert.deepEqual(retained.result, { retained: true });
  assert.equal((await images.readQuestionImages(question.id, question.questionImageIds)).length, 1);
  cloud.cloudClient.auth.stopAutoRefresh();
});

test('an edit during the final migration check leaves the old mode and automatic-sync preference intact', async () => {
  const { payload, data } = await fixture('migration-race');
  const wire = await snapshots.prepareSnapshotQuestionImageUpload(payload, { userId, exists: async () => true, upload: async () => {}, download: async () => { throw new Error('not needed'); } });
  const optIn = await vite.ssrLoadModule('/src/utils/recordSyncOptIn.ts');
  const migration = await vite.ssrLoadModule('/src/utils/wholeSyncMigration.ts');
  optIn.setRecordSyncOptIn(syncId, true); sync.setAutoSyncEnabled(true);
  const stamp = '2026-10-07T03:00:00Z';
  globalThis.fetch = async url => {
    if (String(url).endsWith('/quiz_sync_read')) return new Response(JSON.stringify([{ sync_id: syncId, updated_at: stamp, data: wire }]), { status: 200 });
    await storage.saveAppData({ ...data, questions: data.questions.map(row => ({ ...row, question: 'new local edit' })) });
    return new Response(JSON.stringify([{ sync_id: syncId, updated_at: stamp }]), { status: 200 });
  };
  await assert.rejects(() => migration.migrateToWholeSync(syncId, userId), /更新/);
  assert.equal(optIn.isRecordSyncOptedIn(syncId), true);
  assert.equal(sync.getAutoSyncSettings().enabled, true);
  assert.equal((await storage.loadAppDataAsync()).questions[0].question, 'new local edit');
});

test('full cloud download hydrates both PDFs and question images before returning an importable snapshot', async () => {
  const { payload } = await fixture('mixed-media');
  const pdf = new TextEncoder().encode('%PDF-1.7 test');
  const key = 'quizMake:notes:set:__material_pdf_mixed';
  payload.indexedDbNotes[key] = JSON.stringify({ kind: 'quiz-material-file', version: 1, materialId: 'mixed', updatedAt: payload.updatedAt, dataUrl: 'data:application/pdf;base64,' + Buffer.from(pdf).toString('base64') });
  const materials = await vite.ssrLoadModule('/src/utils/materialCloud.ts');
  const pdfWire = await materials.prepareMaterialUpload(payload, { userId, exists: async () => true, upload: async () => {}, download: async () => pdf });
  const wire = await snapshots.prepareSnapshotQuestionImageUpload(pdfWire, { userId, exists: async () => true, upload: async () => {}, download: async () => { throw new Error('not needed'); } });
  const bodies = await snapshots.verifySnapshotQuestionImages(payload);
  const paths = Object.values(wire.localStorage).flatMap(raw => { try { const value = JSON.parse(raw); return value.path ? [value.path] : []; } catch { return []; } });
  const objects = new Map(paths.map((path, index) => [path, bodies[index].blob]));
  await storage.saveAppData(storage.createEmptyAppData());
  await images.removeQuestionImages(() => true);
  globalThis.fetch = async url => {
    if (String(url).endsWith('/quiz_sync_read')) return new Response(JSON.stringify([{ sync_id: syncId, updated_at: payload.updatedAt, data: wire }]), { status: 200 });
    if (String(url).endsWith('.pdf')) return new Response(pdf, { status: 200 });
    const object = [...objects].find(([path]) => String(url).endsWith(path));
    assert.ok(object, `unexpected download: ${url}`);
    return new Response(await object[1].arrayBuffer(), { status: 200 });
  };
  const downloaded = await sync.downloadSyncData(syncId);
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
  assert.equal(sync.validateSyncPayload(downloaded.value.payload).ok, true);
  assert.equal(JSON.parse(downloaded.value.payload.indexedDbNotes[key]).kind, 'quiz-material-file');
  assert.equal((await snapshots.verifySnapshotQuestionImages(downloaded.value.payload)).length, 2);
  assert.equal((await storage.loadAppDataAsync()).questions.length, 0, 'preview downloads never replace the live dataset');
});
