import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('startup conflict offers a non-destructive path to upload confirmation', () => {
  const source = readFileSync(new URL('../src/components/AutoSyncController.tsx', import.meta.url), 'utf8');
  assert.match(source, /alternateLabel="端末 → クラウドに同期"/);
  assert.match(source, /cancelRemoteImport\(\); onOpenSync\(\)/);
  assert.match(source, /localHash === computePayloadHash\(remote.value.payload\)/);
});

test('manual direction selection retains backups and concurrent-change checks', () => {
  const source = readFileSync(new URL('../src/components/SyncComparison.tsx', import.meta.url), 'utf8');
  assert.match(source, /端末 → クラウドに同期/);
  assert.match(source, /saveBackupPayload\(local,'before-sync'\)/);
  assert.match(source, /saveBackupPayload\(remote.value.payload,'before-sync'\)/);
  assert.match(source, /remote.value\?\.updatedAt !== pending.remote\?\.updatedAt/);
});
