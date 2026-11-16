import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { IDBFactory } from 'fake-indexeddb';
import * as vault from '../src/utils/blobVault.ts';
import { requiredSyncContentHashes } from '../src/utils/learningMediaScope.ts';
import { readRecordSyncStatus } from '../src/utils/recordSyncStatus.ts';

const cloud = new Map(), uploaded = [];
const factory = new IDBFactory(), dbs = [];
async function database() {
  const db = await new Promise((resolve, reject) => {
    const r = factory.open(crypto.randomUUID(), 1);
    r.onupgradeneeded = () => {
      for (const name of [...vault.BLOB_STORES, 'appRecords', 'appRecordMeta', 'appOutbox', 'appRecordConflicts']) r.result.createObjectStore(name);
    };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  dbs.push(db); return db;
}
const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code);
// Replace only the account/network boundary; run the real queue, hash checking,
// reference selection and receiver hydration against independent IDB devices.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/blobCloud.ts')) {
    const mocks = {
      './cloudService': 'export const getCloudAccessToken=async()=>({ok:true,userId:"test-owner",accessToken:"test-token"});',
      './syncService': 'export const getRemoteSyncConfig=()=>({url:"https://example.supabase.co",anonKey:"test-key"});',
      './accountStorage': 'export const getAccountStorageSession=()=>undefined;',
      '../storage': 'export const openAppDb=async()=>globalThis.blobRecoveryTestDb;',
      'tus-js-client': 'export class Upload {constructor(bytes,options){this.bytes=bytes;this.options=options;} async findPreviousUploads(){return [];} start(){globalThis.blobRecoveryTestUpload(this.bytes,this.options);} abort(){return Promise.resolve();}}',
    };
    if (mocks[specifier]) return { url: moduleUrl(mocks[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}});
const { startBlobTransfers, downloadContentBlob } = await import('../src/utils/blobCloud.ts');
const originalFetch = globalThis.fetch;
globalThis.blobRecoveryTestUpload = (bytes, options) => {
  const hash = options.metadata.objectName.split('/').at(-1);
  uploaded.push(hash); cloud.set(hash, bytes); options.onSuccess();
};
globalThis.fetch = async (url, options = {}) => {
  const bytes = cloud.get(String(url).split('/').at(-1));
  return new Response(options.method === 'HEAD' ? null : bytes ?? null, {status: bytes ? 200 : 404});
};
after(() => {
  hooks.deregister(); dbs.forEach(db => db.close()); globalThis.fetch = originalFetch;
  delete globalThis.blobRecoveryTestDb; delete globalThis.blobRecoveryTestUpload;
});

test('queued note/PDF/template bodies reach another device; missing jobs and recovery-only archives are retained', async () => {
  const source = await database(), receiver = await database();
  const raw = JSON.stringify({kind:'quiz-material-file', dataUrl:'data:application/pdf;base64,YWJj', text:'x'.repeat(17000)});
  const packed = await vault.packBlobNote(source, raw), refs = vault.parseBlobNote(packed).blobs;
  const archive = await vault.packBlobNote(source, JSON.stringify({dataUrl:'data:image/png;base64,eHl6'}));
  const archiveRef = vault.parseBlobNote(archive).blobs[0];
  const missing = {sha256:'0'.repeat(64),size:3,type:'image/png'};
  const tx = source.transaction([...vault.BLOB_STORES], 'readwrite'), done = vault.idbDone(tx);
  vault.queueBlobReferences(tx, 'current:["indexedDbNotes","pdf"]', packed);
  vault.queueBlobReferences(tx, 'pending:["indexedDbNotes","missing"]', JSON.stringify({kind:vault.BLOB_NOTE_KIND,version:1,value:{},blobs:[missing]}));
  vault.queueBlobReferences(tx, 'rescue:["indexedDbNotes","old"]', archive);
  for (const ref of [missing,...refs,archiveRef]) vault.queueContentUpload(tx, ref);
  await done;
  assert.deepEqual([...await requiredSyncContentHashes(source)].sort(), [missing.sha256,...refs.map(r=>r.sha256)].sort());
  globalThis.blobRecoveryTestDb = receiver;
  await assert.rejects(vault.unpackBlobNote(receiver, packed, downloadContentBlob), /まだ転送中/);
  await startBlobTransfers(source, async()=>{});
  assert.equal(await vault.unpackBlobNote(receiver, packed, downloadContentBlob), raw);
  assert.equal(uploaded.length, refs.length);
  assert.equal(cloud.has(archiveRef.sha256), false);
  const read = source.transaction('contentBlobJobs'), readDone = vault.idbDone(read);
  const jobs = await vault.idbResult(read.objectStore('contentBlobJobs').getAllKeys()); await readDone;
  assert.deepEqual(jobs.sort(),[missing.sha256,archiveRef.sha256].sort());
  const connection={project:'https://example.supabase.co',userId:'test-owner',syncId:'test-sync'};
  assert.equal((await readRecordSyncStatus(source,connection)).mediaPending,1,'recovery-only archive is not stuck in transfer status');
  assert.equal(await vault.unpackBlobNote(source, packed), raw, 'original remains intact');
  let guards=0;
  await startBlobTransfers(source, async()=>{guards++;throw new Error('account changed');});
  assert.ok(guards>0); assert.equal(uploaded.length,refs.length);
});
