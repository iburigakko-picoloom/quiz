import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

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

const originalSupabaseUrl = process.env.VITE_SUPABASE_URL;
const originalSupabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';

globalThis.localStorage = new MemoryStorage();
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
delete globalThis.indexedDB;

const vite = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});
const sync = await vite.ssrLoadModule('/src/utils/syncService.ts');
const storage = await vite.ssrLoadModule('/src/storage.ts');
const testAccessTokenProvider = async () => ({
  ok: true,
  accessToken: 'test-user-access-token',
  userId: '00000000-0000-4000-8000-000000000001',
});
sync.setSyncAccessTokenProviderForTests(testAccessTokenProvider);

after(async () => {
  await vite.close();
  if (originalSupabaseUrl === undefined) delete process.env.VITE_SUPABASE_URL;
  else process.env.VITE_SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
  else process.env.VITE_SUPABASE_ANON_KEY = originalSupabaseKey;
  delete globalThis.fetch;
});

const syncId = '111111111111111111111111111111111111';
const nextSyncId = '222222222222222222222222222222222222';
const legacyWinnerSyncId = '333333333333333333333333333333333333';
const updatedAt = '2026-08-15T00:00:00.000Z';

function rpcResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('remote metadata uses the lightweight meta RPC instead of downloading the payload', async () => {
  let calledUrl = '';
  let calledBody = null;
  let calledHeaders = null;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    calledBody = JSON.parse(String(init.body));
    calledHeaders = new Headers(init.headers);
    return rpcResponse([{ sync_id: syncId, updated_at: updatedAt }]);
  };

  const result = await sync.getRemoteSyncMeta(syncId);

  assert.deepEqual(result, { ok: true, value: { syncId, updatedAt } });
  assert.match(calledUrl, /\/rest\/v1\/rpc\/quiz_sync_meta$/u);
  assert.deepEqual(calledBody, { p_sync_id: syncId });
  assert.equal(calledHeaders.get('apikey'), 'test-anon-key');
  assert.equal(calledHeaders.get('authorization'), 'Bearer test-user-access-token');
  assert.notEqual(calledHeaders.get('authorization'), 'Bearer test-anon-key');
});

test('signed-out sync fails before network I/O and never falls back to the public API key', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return rpcResponse([]);
  };
  sync.setSyncAccessTokenProviderForTests(async () => ({
    ok: false,
    reason: 'signed-out',
    message: 'クラウド同期を使うにはログインが必要です。',
  }));

  try {
    const result = await sync.getRemoteSyncMeta(syncId);
    assert.deepEqual(result, {
      ok: false,
      code: 'authentication_required',
      error: 'クラウド同期を使うにはログインが必要です。',
    });
    assert.equal(fetchCount, 0);
  } finally {
    sync.setSyncAccessTokenProviderForTests(testAccessTokenProvider);
  }
});

test('pairing codes are normalized, issued for five-minute transfer, and redeemed once', async () => {
  const requests = [];
  localStorage.clear();
  sync.setStoredSyncId(syncId);
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (String(url).endsWith('/quiz_sync_create_pairing_code')) {
      return rpcResponse([{
        result_code: 'ok',
        pairing_code: 'ABCDEFGH',
        expires_at: '2026-08-15T00:05:00.000Z',
      }]);
    }
    return rpcResponse([{ result_code: 'ok', sync_id: nextSyncId }]);
  };

  const issued = await sync.createSyncPairingCode(syncId);
  const redeemed = await sync.redeemSyncPairingCode('abcd-efgh');

  assert.deepEqual(issued, {
    ok: true,
    value: { code: 'ABCDEFGH', expiresAt: '2026-08-15T00:05:00.000Z' },
  });
  assert.deepEqual(redeemed, { ok: true, value: nextSyncId });
  assert.deepEqual(requests[0].body, { p_sync_id: syncId });
  assert.deepEqual(requests[1].body, { p_pairing_code: 'ABCDEFGH' });
  assert.equal(sync.isValidPairingCode('ABCD EFGH'), true);
  assert.equal(sync.isValidPairingCode('ABCDI234'), false, 'ambiguous Crockford characters stay invalid');
});

test('expired or already-used pairing codes return a recoverable not-found result', async () => {
  globalThis.fetch = async () => rpcResponse([{ result_code: 'not_found_or_expired', sync_id: null }]);

  const result = await sync.redeemSyncPairingCode('ABCDEFGH');

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'not_found');
    assert.match(result.error, /有効期限切れ|使用済み/u);
  }
});

test('cloud deletion always sends the confirmed revision and surfaces server conflicts', async () => {
  const bodies = [];
  let conflict = true;
  localStorage.clear();
  sync.setStoredSyncId(syncId);
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    if (conflict) return rpcResponse([{ result_code: 'conflict', sync_id: syncId, updated_at: updatedAt }]);
    return rpcResponse([{ result_code: 'ok', sync_id: syncId, updated_at: updatedAt }]);
  };

  const rejected = await sync.deleteRemoteSyncData(syncId, updatedAt);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'conflict');

  conflict = false;
  const deleted = await sync.deleteRemoteSyncData(syncId, updatedAt);
  assert.deepEqual(deleted, { ok: true, value: true });
  assert.deepEqual(bodies[0], {
    p_sync_id: syncId,
    p_expected_updated_at: updatedAt,
    p_force: false,
  });
});

test('legacy sync IDs rotate atomically to a strong ID without changing the revision', async () => {
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return rpcResponse([{ result_code: 'ok', sync_id: body.p_candidate_sync_id, updated_at: updatedAt }]);
  };
  localStorage.clear();
  sync.setStoredSyncId('old-sync-id');

  const result = await sync.upgradeLegacySyncId('old-sync-id', updatedAt);

  assert.equal(result.ok, true);
  assert.match(body.p_candidate_sync_id, /^[0-9a-f]{36}$/u);
  assert.deepEqual(body, {
    p_legacy_sync_id: 'old-sync-id',
    p_expected_updated_at: updatedAt,
    p_candidate_sync_id: body.p_candidate_sync_id,
  });
  assert.equal(sync.getStoredSyncId(), body.p_candidate_sync_id);
});

test('legacy migration reuses its durable candidate after a lost success response', async () => {
  const candidates = [];
  let requestCount = 0;
  globalThis.fetch = async (_url, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init.body));
    candidates.push(body.p_candidate_sync_id);
    if (requestCount === 1) throw new Error('response lost after commit');
    return rpcResponse([{ result_code: 'ok', sync_id: body.p_candidate_sync_id, updated_at: updatedAt }]);
  };
  localStorage.clear();
  sync.setStoredSyncId('retry-old-id');

  const interrupted = await sync.upgradeLegacySyncId('retry-old-id', updatedAt);
  assert.equal(interrupted.ok, false);
  assert.equal(sync.getStoredSyncId(), 'retry-old-id');

  const retried = await sync.upgradeLegacySyncId('retry-old-id', updatedAt);
  assert.equal(retried.ok, true);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0], candidates[1], 'a retry must use the candidate saved before the first RPC');
  assert.equal(sync.getStoredSyncId(), candidates[0]);
});

test('reload resumes a response-lost legacy migration without overwriting a newer connection', async () => {
  const requests = [];
  let responseLost = true;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (responseLost) {
      responseLost = false;
      throw new Error('response lost after server commit');
    }
    return rpcResponse([{
      result_code: 'ok',
      sync_id: legacyWinnerSyncId,
      updated_at: updatedAt,
    }]);
  };
  localStorage.clear();
  sync.setStoredSyncId('reload-old-id');

  const interrupted = await sync.upgradeLegacySyncId('reload-old-id', updatedAt);
  assert.equal(interrupted.ok, false);
  const durablePending = sync.getPendingLegacySyncUpgrade();
  assert.ok(durablePending, 'a network failure must keep the retry record');
  assert.equal(sync.getStoredSyncId(), 'reload-old-id');

  sync.setStoredSyncId(syncId);
  const reloadedSync = await vite.ssrLoadModule(`/src/utils/syncService.ts?legacy-recovery=${Date.now()}`);
  reloadedSync.setSyncAccessTokenProviderForTests(testAccessTokenProvider);
  const recovered = await reloadedSync.resumePendingLegacySyncUpgrade();

  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.deepEqual(recovered.value, {
      syncId: legacyWinnerSyncId,
      updatedAt,
      requiresConnectionConfirmation: true,
    });
  }
  assert.equal(reloadedSync.getStoredSyncId(), syncId, 'reload recovery must not overwrite connection B');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0], 'reload recovery must reuse the durable legacy/revision/candidate tuple');
  assert.equal(reloadedSync.getPendingLegacySyncUpgrade(), null, 'the accepted winner replaces the pending secret');
  assert.deepEqual(reloadedSync.getPendingLegacySyncCompletion(), {
    syncId: legacyWinnerSyncId,
    updatedAt,
  });
  const persistedValues = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index);
    return key ? localStorage.getItem(key) : null;
  });
  assert.equal(
    persistedValues.some((value) => value?.includes('reload-old-id')),
    false,
    'the legacy bearer ID must not remain persisted after the winner is accepted',
  );
});

test('legacy migration accepts the server-recorded winner from a concurrent candidate', async () => {
  let requestedCandidate = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    requestedCandidate = body.p_candidate_sync_id;
    return rpcResponse([{ result_code: 'ok', sync_id: nextSyncId, updated_at: updatedAt }]);
  };
  localStorage.clear();
  sync.setStoredSyncId('concurrent-old-id');

  const result = await sync.upgradeLegacySyncId('concurrent-old-id', updatedAt);

  assert.equal(result.ok, true);
  assert.match(requestedCandidate, /^[0-9a-f]{36}$/u);
  assert.notEqual(requestedCandidate, nextSyncId);
  assert.equal(sync.getStoredSyncId(), nextSyncId);
});

test('legacy migration durably exposes its winner without overwriting a connection changed in flight', async () => {
  let releaseResponse;
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    requestStarted();
    await new Promise((resolve) => {
      releaseResponse = resolve;
    });
    return rpcResponse([{ result_code: 'ok', sync_id: body.p_candidate_sync_id, updated_at: updatedAt }]);
  };
  localStorage.clear();
  sync.setStoredSyncId('in-flight-old-id');

  const migration = sync.upgradeLegacySyncId('in-flight-old-id', updatedAt);
  await started;
  sync.setStoredSyncId(syncId);
  releaseResponse();
  const result = await migration;

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.requiresConnectionConfirmation, true);
  assert.equal(sync.getStoredSyncId(), syncId, 'the newer connection must remain active');
  const completion = sync.getPendingLegacySyncCompletion();
  assert.equal(completion?.syncId, result.ok ? result.value.syncId : '');
});

test('payload validation enforces the same byte and key limits as the server before network I/O', () => {
  const validPayload = {
    version: 1,
    updatedAt,
    localStorage: {
      [storage.APP_DATA_STORAGE_KEY]: JSON.stringify(storage.createEmptyAppData()),
    },
    indexedDbNotes: {},
  };
  assert.equal(sync.validateSyncPayload(validPayload).ok, true);
  assert.equal(sync.MAX_SYNC_PAYLOAD_BYTES, 32 * 1024 * 1024);
  const expandedPayload = {
    ...validPayload,
    localStorage: { ...validPayload.localStorage, 'quizMake:capacity-test': 'x'.repeat(9 * 1024 * 1024) },
  };
  assert.equal(sync.validateSyncPayload(expandedPayload).ok, true, 'existing data above the old 8 MiB limit stays intact');
  assert.equal(sync.validateSyncPayload(expandedPayload, { wire: true }).ok, true);

  const oversized = {
    ...validPayload,
    localStorage: {
      ...validPayload.localStorage,
      'quizMake:oversized': 'x'.repeat(sync.MAX_SYNC_PAYLOAD_BYTES),
    },
  };
  const oversizedResult = sync.validateSyncPayload(oversized);
  assert.equal(oversizedResult.ok, false);
  if (!oversizedResult.ok) {
    assert.equal(oversizedResult.code, 'payload_too_large');
    assert.match(oversizedResult.error, /32 MB/);
  }

  const tooManyKeys = Object.fromEntries(Array.from(
    { length: sync.MAX_SYNC_STORAGE_KEYS },
    (_, index) => [`quizMake:test:${index}`, 'x'],
  ));
  tooManyKeys[storage.APP_DATA_STORAGE_KEY] = JSON.stringify(storage.createEmptyAppData());
  const keyResult = sync.validateSyncPayload({ ...validPayload, localStorage: tooManyKeys });
  assert.equal(keyResult.ok, false);
  if (!keyResult.ok) assert.equal(keyResult.code, 'invalid');
});

test('PDF sync separates bytes, skips unchanged uploads, and restores portable local data', async () => {
  const materials = await vite.ssrLoadModule('/src/utils/materialCloud.ts');
  const key = 'quizMake:notes:set:__material_pdf_pdf1';
  const bytes = new Uint8Array(25 * 1024 * 1024); bytes.set(new TextEncoder().encode('%PDF-1.7'));
  const file = { kind: 'quiz-material-file', version: 1, materialId: 'pdf1', updatedAt, dataUrl: 'data:application/pdf;base64,' + Buffer.from(bytes).toString('base64') };
  const payload = { version: 1, updatedAt, localStorage: { [storage.APP_DATA_STORAGE_KEY]: JSON.stringify(storage.createEmptyAppData()) }, indexedDbNotes: { [key]: JSON.stringify(file) } };
  const original = payload.indexedDbNotes[key];
  const remoteFiles = new Map(); let uploaded = 0;
  const transport = { userId: '00000000-0000-4000-8000-000000000001',
    exists: async file => remoteFiles.has(file.path),
    upload: async (file, bytes) => { uploaded++; remoteFiles.set(file.path, bytes); },
    download: async file => remoteFiles.get(file.path),
  };
  assert.equal(sync.validateSyncPayload(payload).ok, true, 'PDF bytes do not consume the 32 MiB snapshot budget');
  assert.equal(sync.validateSyncPayload(payload, { wire: true }).ok, false, 'oversized inline RPC payload remains forbidden');
  const wire = await materials.prepareMaterialUpload(payload, transport);
  assert.equal(sync.validateSyncPayload(wire, { wire: true }).ok, true);
  assert.equal(sync.validateSyncPayload(wire).ok, false, 'unresolved pointers cannot overwrite local PDFs');
  assert.ok(JSON.stringify(wire).length < 2000);
  await materials.prepareMaterialUpload(payload, transport);
  assert.equal(uploaded, 1);
  assert.equal(payload.indexedDbNotes[key], original, 'export snapshot is immutable');
  const restored = await materials.hydrateMaterialDownload(wire, transport);
  assert.deepEqual(JSON.parse(restored.indexedDbNotes[key]), file);
  assert.equal(sync.computePayloadHash(restored), sync.computePayloadHash(payload));
  const reorderedFile = { updatedAt: file.updatedAt, dataUrl: file.dataUrl, ...file };
  assert.equal(sync.computePayloadHash({ ...payload, indexedDbNotes: { [key]: JSON.stringify(reorderedFile) } }), sync.computePayloadHash(payload));
  await assert.rejects(materials.hydrateMaterialDownload(wire, { ...transport, userId: '00000000-0000-4000-8000-000000000002' }), /所有者/);
  await assert.rejects(materials.hydrateMaterialDownload(wire, { ...transport, download: async () => new Uint8Array([1, 2, 3]) }), /保存内容/);
  await assert.rejects(materials.prepareMaterialUpload(payload, { ...transport, exists: async () => false, upload: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(payload.indexedDbNotes[key], original);
});

test('remote PDF download is verified before returning an importable snapshot', async () => {
  const materials = await vite.ssrLoadModule('/src/utils/materialCloud.ts');
  const key = 'quizMake:notes:set:__material_pdf_pdf2';
  const file = { kind: 'quiz-material-file', version: 1, materialId: 'pdf2', updatedAt, dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.7 test').toString('base64') };
  const payload = { version: 1, updatedAt, localStorage: { [storage.APP_DATA_STORAGE_KEY]: JSON.stringify(storage.createEmptyAppData()) }, indexedDbNotes: { [key]: JSON.stringify(file) } };
  let binary;
  const wire = await materials.prepareMaterialUpload(payload, { userId: (await testAccessTokenProvider()).userId, exists: async () => false, upload: async (_file, bytes) => { binary = bytes; } });
  localStorage.clear(); sync.setStoredSyncId(syncId);
  globalThis.fetch = async url => String(url).includes('/storage/v1/object/') ? new Response(binary) : rpcResponse([{ sync_id: syncId, updated_at: updatedAt, data: wire }]);
  const result = await sync.downloadSyncData(syncId);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(JSON.parse(result.value.payload.indexedDbNotes[key]), file);
  globalThis.fetch = async url => String(url).includes('/storage/v1/object/') ? new Response('broken') : rpcResponse([{ sync_id: syncId, updated_at: updatedAt, data: wire }]);
  assert.equal((await sync.downloadSyncData(syncId)).ok, false);
  assert.equal(localStorage.getItem(key), null, 'failed downloads never write notes');
});
